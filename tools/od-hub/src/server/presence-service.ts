import type { WorkspaceMemberRow, WorkspaceRole } from './store.js';

/**
 * Project presence roster (PLAN §3.2 `presence:{ws}:{project}`, §4.3 collab
 * rows). Presence is disposable lease state: the web client beats every 10s
 * and the daemon re-establishes it on the next beat, so it lives in process
 * memory (no store round trip, no GitLab call) and every operation is O(roster).
 *
 * Lease key is `clientId` (one member, many tabs). Leases expire `ttlMs` after
 * their last heartbeat (default 30s, aligned with the daemon's own
 * presence-tracker.ts:31 DEFAULT_TTL_MS). Expiry is swept lazily on every
 * access of the project roster; a sweep that evicted something reports it so
 * the caller can emit `presence-changed`.
 */

export const DEFAULT_PRESENCE_TTL_MS = 30_000;

/** Roster entry as printed by `presence heartbeat|list|leave` (vela-cli-collab-client.ts:193-218 toPresenceMember). */
export interface PresenceViewerWire {
  memberId: string;
  displayName: string;
  role: WorkspaceRole;
  avatarUrl: string | null;
  filePath: string | null;
  heartbeatAt: string;
  activity?: unknown;
}

interface Lease {
  viewer: PresenceViewerWire;
  /** Epoch ms of the last heartbeat. */
  at: number;
}

export interface HeartbeatInput {
  clientId: string;
  member: WorkspaceMemberRow;
  displayName?: string | null;
  filePath?: string | null;
  /** `undefined` = flag absent (omit from the wire); any other JSON value passes through verbatim. */
  activity?: unknown;
}

export interface PresenceMutation {
  viewers: PresenceViewerWire[];
  /** True when the roster changed in a way subscribers must learn about (first appearance, leave, eviction). */
  changed: boolean;
}

export class PresenceService {
  private readonly rosters = new Map<string, Map<string, Lease>>(); // `${ws}\0${project}` -> clientId -> lease
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(options: { ttlMs?: number; now?: () => Date } = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`presence ttlMs must be a positive number, got ${String(options.ttlMs)}`);
    this.ttlMs = ttlMs;
    this.now = options.now ?? (() => new Date());
  }

  get ttl(): number {
    return this.ttlMs;
  }

  /** Sweep expired leases; returns whether anything was evicted. */
  private sweep(roster: Map<string, Lease>, nowMs: number): boolean {
    const cutoff = nowMs - this.ttlMs;
    let evicted = false;
    for (const [clientId, lease] of roster) {
      if (lease.at < cutoff) {
        roster.delete(clientId);
        evicted = true;
      }
    }
    return evicted;
  }

  private static key(workspaceId: string, projectId: string): string {
    return `${workspaceId}\0${projectId}`;
  }

  private roster(workspaceId: string, projectId: string): Map<string, Lease> {
    const key = PresenceService.key(workspaceId, projectId);
    let roster = this.rosters.get(key);
    if (!roster) {
      roster = new Map();
      this.rosters.set(key, roster);
    }
    return roster;
  }

  /**
   * Drop the roster map once it is empty so a GET for an unknown project (or a
   * project everyone left) does not pin a Map per key for the process lifetime.
   */
  private release(workspaceId: string, projectId: string, roster: Map<string, Lease>): void {
    if (roster.size === 0) this.rosters.delete(PresenceService.key(workspaceId, projectId));
  }

  /** Number of (workspace, project) rosters currently held; exposed for tests and diagnostics. */
  get rosterCount(): number {
    return this.rosters.size;
  }

  /** Snapshots: `activity` is caller JSON, so clone it rather than share the parsed object across responses. */
  private viewers(roster: Map<string, Lease>): PresenceViewerWire[] {
    return [...roster.values()].map((lease) => ({
      ...lease.viewer,
      ...('activity' in lease.viewer ? { activity: structuredClone(lease.viewer.activity) } : {}),
    }));
  }

  heartbeat(workspaceId: string, projectId: string, input: HeartbeatInput): PresenceMutation {
    const nowMs = this.now().getTime();
    const roster = this.roster(workspaceId, projectId);
    const evicted = this.sweep(roster, nowMs);
    const joined = !roster.has(input.clientId);
    const displayName = input.displayName?.trim() || input.member.displayName?.trim() || input.member.memberId;
    const viewer: PresenceViewerWire = {
      memberId: input.member.memberId,
      displayName,
      role: input.member.role,
      avatarUrl: input.member.avatarUrl ?? null,
      filePath: input.filePath ?? null,
      heartbeatAt: new Date(nowMs).toISOString(),
      ...(input.activity === undefined ? {} : { activity: structuredClone(input.activity) }),
    };
    roster.set(input.clientId, { viewer, at: nowMs });
    return { viewers: this.viewers(roster), changed: evicted || joined };
  }

  list(workspaceId: string, projectId: string): PresenceMutation {
    const roster = this.roster(workspaceId, projectId);
    const evicted = this.sweep(roster, this.now().getTime());
    const viewers = this.viewers(roster);
    this.release(workspaceId, projectId, roster);
    return { viewers, changed: evicted };
  }

  /**
   * Drop one lease. A missing `clientId` means "this member left everywhere"
   * (legacy leave, e2e/lib/collab-hub-core/commands.ts:464-478); the daemon
   * always sends one, so closing one tab never evicts another tab.
   */
  leave(workspaceId: string, projectId: string, memberId: string, clientId: string | null): PresenceMutation {
    const roster = this.roster(workspaceId, projectId);
    const evicted = this.sweep(roster, this.now().getTime());
    let removed = false;
    if (clientId !== null) {
      removed = roster.delete(clientId);
    } else {
      for (const [key, lease] of roster) {
        if (lease.viewer.memberId === memberId) {
          roster.delete(key);
          removed = true;
        }
      }
    }
    const viewers = this.viewers(roster);
    this.release(workspaceId, projectId, roster);
    return { viewers, changed: evicted || removed };
  }

  /** Remove every lease of a member across all projects of a workspace (membership removed). Returns touched project ids. */
  evictMember(workspaceId: string, memberId: string): string[] {
    const touched: string[] = [];
    for (const [key, roster] of this.rosters) {
      if (!key.startsWith(`${workspaceId}\0`)) continue;
      let hit = false;
      for (const [clientId, lease] of roster) {
        if (lease.viewer.memberId === memberId) {
          roster.delete(clientId);
          hit = true;
        }
      }
      if (hit) touched.push(key.slice(workspaceId.length + 1));
      if (roster.size === 0) this.rosters.delete(key);
    }
    return touched;
  }
}
