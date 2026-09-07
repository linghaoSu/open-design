import { randomBytes } from 'node:crypto';

import {
  MANIFEST_DIGEST_PATTERN,
  PUBLISHED_REF,
  manifestDigest,
  normalizeManifest,
  type ManifestEntry,
  type ResourceKind,
} from '../shared/manifest.js';
import type { BlobStore } from './blob-store.js';
import { digestFacesForEvent } from './digest.js';
import type {
  HubStore,
  OutboxEventInput,
  PublicSnapshotRow,
  PullReceiptRow,
  ResourceRow,
  ResourceVersionRow,
  SideEffects,
  TeamProjectRow,
  TeamProjectSyncState,
  WorkspaceMemberRow,
} from './store.js';

/** authorized-team-project-pull.ts:13 — the daemon rejects receipts living longer than this. */
export const PULL_RECEIPT_TTL_MS = 2_000;

/** Public snapshot slugs: 32 random bytes as base64url (256-bit), one path segment. */
export const SNAPSHOT_SLUG_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** vela-cli-resource-adapter.ts:345-362 (parseVelaResourceSnapshot) — `slug` required, the rest strings. */
export interface PublicSnapshotWire {
  slug: string;
  name: string;
  kind: ResourceKind;
  versionId: string;
  createdAt: string;
}

/** Typed failure the HTTP layer maps to `{status, error}`; `code` strings are daemon contract (PLAN §6.3). */
export class ResourceServiceError extends Error {
  constructor(readonly status: number, readonly code: string, detail?: string) {
    super(detail ?? code);
  }
}

export interface Actor {
  workspaceId: string;
  membership: WorkspaceMemberRow;
  userId: string;
}

/** Workspace owners/admins may publish over, tombstone, or re-catalog resources owned by others. */
export function canManageAll(membership: WorkspaceMemberRow): boolean {
  return membership.role === 'owner' || membership.role === 'admin';
}

/** `resource shared` row (vela-cli-team-projects.ts:76-84, team-resource-share.ts:358-364). */
export interface SharedResourceWire {
  id: string;
  teamId: string;
  kind: ResourceKind;
  ownerMemberId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  deletedAt: null;
  publishedVersion: { id: string; version: number } | null;
}

export function toSharedResourceWire(row: ResourceRow): SharedResourceWire {
  return {
    id: row.resourceId,
    teamId: row.workspaceId,
    kind: row.kind,
    ownerMemberId: row.ownerMemberId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    deletedAt: null,
    publishedVersion: row.publishedVersionId ? { id: row.publishedVersionId, version: row.publishedVersion } : null,
  };
}

/** `team-projects list|get|upsert` row (vela-cli-team-projects.ts:58-69, 407-462). */
export interface TeamProjectWire {
  id: string;
  workspaceId: string;
  projectId: string;
  resourceId: string;
  ownerMemberId: string;
  displayName: string | null;
  syncState: TeamProjectSyncState;
  lastSyncedVersionId: string | null;
  /** null = no published ref (daemon hides the row); string = current immutable version. */
  publishedVersionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  access: { canView: boolean; canComment: boolean; canEdit: boolean; frozen: boolean };
}

export function toTeamProjectWire(row: TeamProjectRow, resource: ResourceRow | null, viewerMemberId: string): TeamProjectWire {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    resourceId: row.resourceId,
    ownerMemberId: row.ownerMemberId,
    displayName: row.displayName,
    syncState: row.syncState,
    lastSyncedVersionId: row.lastSyncedVersionId,
    publishedVersionId: resource?.publishedVersionId ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    access: { canView: true, canComment: true, canEdit: row.ownerMemberId === viewerMemberId, frozen: false },
  };
}

/** Receipt the shim prints for `team-projects pull` (authorized-team-project-pull.ts:26-41). */
export interface PullReceiptWire {
  schemaVersion: 1;
  workspaceId: string;
  resourceTeamId: string;
  viewerMemberId: string;
  ownerMemberId: string;
  projectId: string;
  resourceId: string;
  ref: 'published';
  version: number;
  versionId: string;
  manifestDigest: string;
  manifestEntryCount: number;
  lifecycleState: 'active';
  authorizedAt: string;
  expiresAt: string;
  nonce: string;
}

interface WorkspaceEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Resource / catalog / receipt use cases behind the HTTP routes. Every write
 * goes through one store transaction that also carries the outbox rows,
 * digest bumps, and audit entries (see `SideEffects`), then `onOutbox` asks
 * the relay to drain.
 */
export class ResourceService {
  constructor(
    private readonly deps: {
      store: HubStore;
      blobs: BlobStore;
      now: () => Date;
      onOutbox: () => void;
    },
  ) {}

  private events(workspaceId: string, events: WorkspaceEvent[], audit: SideEffects['audit'] = []): SideEffects {
    const at = this.deps.now().toISOString();
    const outbox: OutboxEventInput[] = events.map((event) => ({
      workspaceId,
      userId: null,
      topic: 'workspace',
      eventName: 'workspace-event',
      payload: { ...event, workspaceId, at },
    }));
    const digestBumps: SideEffects['digestBumps'] = [];
    for (const event of events) {
      for (const face of digestFacesForEvent(event.type)) digestBumps.push({ workspaceId, face });
    }
    return { outbox, digestBumps, audit };
  }

  // ---- versions -------------------------------------------------------------------

  /**
   * Validate the manifest, check every referenced blob is present, then run
   * the transactional CAS publish. Blob presence is checked outside the
   * transaction (blob store is the filesystem) but BEFORE the version row is
   * written, and blobs are never deleted, so a committed version always has
   * its bytes.
   */
  async publish(actor: Actor, kind: ResourceKind, resourceId: string, body: Record<string, unknown>): Promise<{
    resource: ResourceRow;
    version: ResourceVersionRow;
  }> {
    let manifest: ManifestEntry[];
    try {
      manifest = normalizeManifest(body.manifest);
    } catch (error) {
      throw new ResourceServiceError(400, 'invalid_manifest', error instanceof Error ? error.message : String(error));
    }
    const digest = manifestDigest(manifest);
    if (typeof body.manifestDigest === 'string' && body.manifestDigest !== digest) {
      // The client computed a digest over a different entry set than it sent.
      throw new ResourceServiceError(400, 'manifest_digest_mismatch');
    }
    let expectedVersion: number | null = null;
    if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
      if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
        throw new ResourceServiceError(400, 'invalid_expected_version');
      }
      expectedVersion = body.expectedVersion as number;
    }
    let metadata: Record<string, unknown> | null | undefined;
    if (body.metadata === null) metadata = null;
    else if (body.metadata !== undefined) {
      if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) throw new ResourceServiceError(400, 'invalid_metadata');
      metadata = body.metadata as Record<string, unknown>;
    }
    const missing = await this.deps.blobs.missing(manifest.map((e) => e.sha256));
    if (missing.length > 0) throw new ResourceServiceError(409, 'blobs_missing', `${missing.length} blob(s) missing`);
    for (const entry of manifest) {
      const size = await this.deps.blobs.size(entry.sha256);
      if (size !== null && size !== entry.size) throw new ResourceServiceError(400, 'manifest_size_mismatch', entry.path);
    }

    const result = await this.deps.store.publishVersion(
      {
        workspaceId: actor.workspaceId,
        resourceId,
        kind,
        manifest,
        manifestDigest: digest,
        expectedVersion,
        actorMemberId: actor.membership.memberId,
        ...(metadata !== undefined ? { metadata } : {}),
      },
      { actorCanManageAll: canManageAll(actor.membership) },
      ({ resource, version, teamProjects }) => {
        // fake-collab-hub.ts:725-740 — project kind with a catalog row → content
        // changed; anything else → the shared-resources index changed.
        const events: WorkspaceEvent[] = kind === 'project' && teamProjects.length > 0
          ? teamProjects.map((project) => ({ type: 'project-content-changed', projectId: project.projectId, version: version.version }))
          : [{ type: 'team-resources-changed', resourceId, resourceKind: kind, resourceStatus: 'shared' }];
        return this.events(actor.workspaceId, events, [{
          actorUserId: actor.userId, workspaceId: actor.workspaceId, action: 'resource_publish', target: resourceId,
          details: { kind, version: version.version, versionId: version.versionId, manifestDigest: digest, entryCount: version.entryCount, ownerMemberId: resource.ownerMemberId },
        }]);
      },
    );
    switch (result.kind) {
      case 'published':
        this.deps.onOutbox();
        return { resource: result.resource, version: result.version };
      case 'conflict':
        throw new ResourceServiceError(409, 'resource_version_conflict', `published version is ${result.publishedVersion}`);
      case 'not_found':
        throw new ResourceServiceError(404, 'resource_not_found');
      case 'kind_conflict':
        throw new ResourceServiceError(409, 'resource_kind_conflict', `stored kind is ${result.storedKind}`);
      case 'forbidden':
        throw new ResourceServiceError(403, 'resource_forbidden');
      default:
        throw new ResourceServiceError(500, 'internal_error');
    }
  }

  async requireResource(workspaceId: string, resourceId: string): Promise<ResourceRow> {
    const row = await this.deps.store.getResource(workspaceId, resourceId);
    if (!row) throw new ResourceServiceError(404, 'resource_not_found');
    return row;
  }

  /**
   * `{version|null, versionId|null}`; a live resource never published and an
   * unknown id both read as null. A tombstoned id is 404 resource_not_found
   * (PLAN §3.4: once removed, every resource-scoped call answers 404).
   */
  async head(workspaceId: string, resourceId: string, ref: string): Promise<{ version: number | null; versionId: string | null }> {
    requirePublishedRef(ref);
    const row = await this.deps.store.getResource(workspaceId, resourceId, { includeDeleted: true });
    if (row?.deletedAt) throw new ResourceServiceError(404, 'resource_not_found');
    if (!row || row.publishedVersion === 0) return { version: null, versionId: null };
    return { version: row.publishedVersion, versionId: row.publishedVersionId };
  }

  async manifest(workspaceId: string, resourceId: string, versionId: string): Promise<ResourceVersionRow> {
    await this.requireResource(workspaceId, resourceId);
    const version = versionId === PUBLISHED_REF
      ? await this.publishedVersion(workspaceId, resourceId)
      : await this.deps.store.getResourceVersionById(workspaceId, resourceId, versionId);
    if (!version) throw new ResourceServiceError(404, 'version_not_found');
    return version;
  }

  private async publishedVersion(workspaceId: string, resourceId: string): Promise<ResourceVersionRow | null> {
    const row = await this.requireResource(workspaceId, resourceId);
    if (row.publishedVersion === 0) return null;
    return this.deps.store.getResourceVersion(workspaceId, resourceId, row.publishedVersion);
  }

  /**
   * Tombstone a resource. Idempotent: removing an already-tombstoned id is a
   * no-op success (`already_removed`, no event), so a client retrying a
   * delete after a lost response converges instead of seeing 404.
   */
  async remove(actor: Actor, resourceId: string): Promise<'removed' | 'already_removed'> {
    const result = await this.deps.store.tombstoneResource(
      actor.workspaceId,
      resourceId,
      { memberId: actor.membership.memberId, canManageAll: canManageAll(actor.membership) },
      (resource) => this.events(
        actor.workspaceId,
        resource.kind === 'project'
          ? []
          : [{ type: 'team-resources-changed', resourceId, resourceKind: resource.kind, resourceStatus: 'retracted' }],
        [{ actorUserId: actor.userId, workspaceId: actor.workspaceId, action: 'resource_remove', target: resourceId, details: { kind: resource.kind, publishedVersion: resource.publishedVersion } }],
      ),
    );
    switch (result.kind) {
      case 'removed':
        this.deps.onOutbox();
        return 'removed';
      case 'already_removed':
        return 'already_removed';
      case 'not_found':
        throw new ResourceServiceError(404, 'resource_not_found');
      case 'forbidden':
        throw new ResourceServiceError(403, 'resource_forbidden');
      default:
        throw new ResourceServiceError(500, 'internal_error');
    }
  }

  async shared(workspaceId: string): Promise<SharedResourceWire[]> {
    return (await this.deps.store.listResources(workspaceId)).map(toSharedResourceWire);
  }

  // ---- catalog ---------------------------------------------------------------------

  async listTeamProjects(actor: Actor): Promise<TeamProjectWire[]> {
    const rows = await this.deps.store.listTeamProjects(actor.workspaceId);
    const out: TeamProjectWire[] = [];
    for (const row of rows) {
      const resource = await this.deps.store.getResource(actor.workspaceId, row.resourceId);
      out.push(toTeamProjectWire(row, resource, actor.membership.memberId));
    }
    return out;
  }

  async getTeamProject(actor: Actor, projectId: string): Promise<TeamProjectWire> {
    const row = await this.deps.store.getTeamProject(actor.workspaceId, projectId);
    if (!row) throw new ResourceServiceError(404, 'team_project_not_found');
    const resource = await this.deps.store.getResource(actor.workspaceId, row.resourceId);
    return toTeamProjectWire(row, resource, actor.membership.memberId);
  }

  async upsertTeamProject(actor: Actor, projectId: string, body: Record<string, unknown>): Promise<TeamProjectWire> {
    const resourceId = typeof body.resourceId === 'string' ? body.resourceId.trim() : '';
    if (!resourceId) throw new ResourceServiceError(400, 'resource_id_required');
    const syncState = body.syncState === undefined ? undefined : toSyncState(body.syncState);
    if (body.metadata !== undefined && body.metadata !== null && (typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
      throw new ResourceServiceError(400, 'invalid_metadata');
    }
    const result = await this.deps.store.upsertTeamProject(
      {
        workspaceId: actor.workspaceId,
        projectId,
        resourceId,
        actorMemberId: actor.membership.memberId,
        ...(body.displayName !== undefined ? { displayName: typeof body.displayName === 'string' ? body.displayName : null } : {}),
        ...(syncState !== undefined ? { syncState } : {}),
        ...(body.lastSyncedVersionId !== undefined ? { lastSyncedVersionId: typeof body.lastSyncedVersionId === 'string' ? body.lastSyncedVersionId : null } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata as Record<string, unknown> | null } : {}),
      },
      { actorCanManageAll: canManageAll(actor.membership) },
      // fake-collab-hub.ts:637-669 — first write announces the row, later writes its metadata.
      (row, created) => this.events(
        actor.workspaceId,
        [{ type: created ? 'team-projects-changed' : 'project-metadata-changed', projectId }],
        [{ actorUserId: actor.userId, workspaceId: actor.workspaceId, action: created ? 'team_project_create' : 'team_project_update', target: projectId, details: { resourceId, syncState: row.syncState } }],
      ),
    );
    if (result.kind === 'forbidden') throw new ResourceServiceError(403, 'team_project_forbidden');
    this.deps.onOutbox();
    const resource = await this.deps.store.getResource(actor.workspaceId, result.row.resourceId);
    return toTeamProjectWire(result.row, resource, actor.membership.memberId);
  }

  /**
   * Un-catalog a project. Idempotent: a missing row is a success with no
   * event, because the daemon's unshare path retries the DELETE after a lost
   * response and expects `{ok:true}` (vela-cli-team-projects.ts remove,
   * runtime.ts unshare; vela-cli-resource-adapter.ts ghost-card note). Owner /
   * admin gating still applies when the row exists.
   */
  async removeTeamProject(actor: Actor, projectId: string): Promise<'removed' | 'already_removed'> {
    const result = await this.deps.store.removeTeamProject(
      actor.workspaceId,
      projectId,
      { memberId: actor.membership.memberId, canManageAll: canManageAll(actor.membership) },
      (row) => this.events(
        actor.workspaceId,
        [{ type: 'team-projects-changed', projectId }],
        [{ actorUserId: actor.userId, workspaceId: actor.workspaceId, action: 'team_project_remove', target: projectId, details: { resourceId: row.resourceId } }],
      ),
    );
    if (result.kind === 'not_found') return 'already_removed';
    if (result.kind === 'forbidden') throw new ResourceServiceError(403, 'team_project_forbidden');
    this.deps.onOutbox();
    return 'removed';
  }

  // ---- pull receipts ----------------------------------------------------------------

  /**
   * Authorize one member-side pull of the exact published version
   * (authorized-team-project-pull.ts:134-184 lists what the daemon checks):
   * the viewer must be an ACTIVE member other than the owner, the requested
   * version must be the current published one, and the receipt lives 2000 ms.
   */
  async authorizePull(actor: Actor, projectId: string, body: Record<string, unknown>): Promise<PullReceiptWire> {
    requirePublishedRef(typeof body.ref === 'string' ? body.ref : PUBLISHED_REF);
    const expectedVersion = body.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
      throw new ResourceServiceError(400, 'invalid_expected_version');
    }
    const project = await this.deps.store.getTeamProject(actor.workspaceId, projectId);
    if (!project) throw new ResourceServiceError(404, 'team_project_not_found');
    if (project.ownerMemberId === actor.membership.memberId) {
      // The owner's mirror is the source of truth; a receipt naming owner==viewer
      // would be rejected by the daemon anyway ("binding is incomplete").
      throw new ResourceServiceError(409, 'authorized_team_project_pull_rejected', 'owner cannot pull own project');
    }
    const resource = await this.deps.store.getResource(actor.workspaceId, project.resourceId);
    if (!resource) throw new ResourceServiceError(404, 'resource_not_found');
    if (resource.publishedVersion === 0 || resource.publishedVersion !== expectedVersion) {
      throw new ResourceServiceError(409, 'authorized_team_project_pull_rejected', `published version is ${resource.publishedVersion}`);
    }
    const version = await this.deps.store.getResourceVersion(actor.workspaceId, project.resourceId, resource.publishedVersion);
    if (!version || !MANIFEST_DIGEST_PATTERN.test(version.manifestDigest)) throw new ResourceServiceError(500, 'internal_error');
    const authorizedAt = this.deps.now();
    const expiresAt = new Date(authorizedAt.getTime() + PULL_RECEIPT_TTL_MS);
    const receipt: PullReceiptRow = {
      nonce: randomBytes(16).toString('base64url'),
      workspaceId: actor.workspaceId,
      projectId,
      resourceId: project.resourceId,
      viewerMemberId: actor.membership.memberId,
      ownerMemberId: project.ownerMemberId,
      version: version.version,
      versionId: version.versionId,
      manifestDigest: version.manifestDigest,
      authorizedAt: authorizedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      consumedAt: null,
    };
    await this.deps.store.createPullReceipt(receipt, {
      audit: [{
        actorUserId: actor.userId, workspaceId: actor.workspaceId, action: 'team_project_pull_authorize', target: projectId,
        details: { nonce: receipt.nonce, version: receipt.version, versionId: receipt.versionId, ownerMemberId: receipt.ownerMemberId },
      }],
    });
    return {
      schemaVersion: 1,
      workspaceId: receipt.workspaceId,
      resourceTeamId: receipt.workspaceId,
      viewerMemberId: receipt.viewerMemberId,
      ownerMemberId: receipt.ownerMemberId,
      projectId: receipt.projectId,
      resourceId: receipt.resourceId,
      ref: 'published',
      version: receipt.version,
      versionId: receipt.versionId,
      manifestDigest: receipt.manifestDigest,
      manifestEntryCount: version.entryCount,
      lifecycleState: 'active',
      authorizedAt: receipt.authorizedAt,
      expiresAt: receipt.expiresAt,
      nonce: receipt.nonce,
    };
  }

  // ---- public snapshots (collab-sync.ts:1312-1340; PLAN §3.2 public_snapshots) ----------

  /**
   * `POST /api/v1/resources/:id/snapshots {ref:"published", name}` -> pin the
   * current published version under a random slug. The pin is by versionId so
   * a later publish never changes what a shared link serves. Owner/admin may
   * snapshot anybody's resource; a plain member only their own.
   */
  async createSnapshot(actor: Actor, resourceId: string, body: Record<string, unknown>): Promise<PublicSnapshotWire> {
    requirePublishedRef(typeof body.ref === 'string' ? body.ref : PUBLISHED_REF);
    const resource = await this.requireResource(actor.workspaceId, resourceId);
    if (!canManageAll(actor.membership) && resource.ownerMemberId !== actor.membership.memberId) {
      throw new ResourceServiceError(403, 'resource_forbidden');
    }
    if (resource.publishedVersion === 0 || !resource.publishedVersionId) throw new ResourceServiceError(409, 'resource_not_published');
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 256) : '';
    const row: PublicSnapshotRow = {
      slug: randomBytes(32).toString('base64url'),
      workspaceId: actor.workspaceId,
      resourceId,
      versionId: resource.publishedVersionId,
      name,
      kind: resource.kind,
      createdAt: this.deps.now().toISOString(),
      redactedAt: null,
    };
    await this.deps.store.createPublicSnapshot(row, {
      audit: [{
        actorUserId: actor.userId, actorMemberId: actor.membership.memberId, workspaceId: actor.workspaceId, action: 'snapshot_create', target: row.slug,
        details: { resourceId, versionId: row.versionId, kind: row.kind, name },
      }],
    });
    return toSnapshotWire(row);
  }

  /**
   * `DELETE /api/v1/resources/:id/snapshots/:slug` -> `{ok:true}`, idempotent:
   * an already-redacted or unknown slug is still ok (collab-sync.ts:1335 retries
   * redaction as compensation and must converge). A slug that belongs to a
   * different resource or workspace is `404 snapshot_not_found` so a redact
   * cannot be aimed across scopes.
   */
  async redactSnapshot(actor: Actor, resourceId: string, slug: string): Promise<'redacted' | 'already_redacted'> {
    if (!SNAPSHOT_SLUG_PATTERN.test(slug)) throw new ResourceServiceError(404, 'snapshot_not_found');
    const row = await this.deps.store.getPublicSnapshot(slug);
    if (!row) return 'already_redacted';
    if (row.workspaceId !== actor.workspaceId || row.resourceId !== resourceId) throw new ResourceServiceError(404, 'snapshot_not_found');
    if (!canManageAll(actor.membership)) {
      const resource = await this.deps.store.getResource(actor.workspaceId, resourceId, { includeDeleted: true });
      if (resource && resource.ownerMemberId !== actor.membership.memberId) throw new ResourceServiceError(403, 'resource_forbidden');
    }
    const redacted = await this.deps.store.redactPublicSnapshot(slug, (snapshot) => ({
      audit: [{
        actorUserId: actor.userId, actorMemberId: actor.membership.memberId, workspaceId: actor.workspaceId, action: 'snapshot_redact', target: slug,
        details: { resourceId, versionId: snapshot.versionId },
      }],
    }));
    return redacted ? 'redacted' : 'already_redacted';
  }

  /**
   * Anonymous read: the manifest entry a public slug pins for `path`, or null
   * when the slug is unknown/redacted or the path is not in the version.
   * Callers stream the blob; the store is never consulted about workspaces or
   * membership — the slug IS the capability.
   */
  async resolvePublicFile(slug: string, path: string): Promise<{ snapshot: PublicSnapshotRow; entry: ManifestEntry } | null> {
    if (!SNAPSHOT_SLUG_PATTERN.test(slug)) return null;
    const snapshot = await this.deps.store.getPublicSnapshot(slug);
    if (!snapshot || snapshot.redactedAt) return null;
    const version = await this.deps.store.getResourceVersionById(snapshot.workspaceId, snapshot.resourceId, snapshot.versionId);
    if (!version) return null;
    const entry = version.manifest.find((e) => e.path === path);
    return entry ? { snapshot, entry } : null;
  }
}

export function toSnapshotWire(row: PublicSnapshotRow): PublicSnapshotWire {
  return { slug: row.slug, name: row.name, kind: row.kind, versionId: row.versionId, createdAt: row.createdAt };
}

function requirePublishedRef(ref: string): void {
  if (ref !== PUBLISHED_REF) throw new ResourceServiceError(404, 'ref_not_found');
}

export function toSyncState(value: unknown): TeamProjectSyncState {
  if (value === 'syncing' || value === 'synced' || value === 'failed' || value === 'pending_upload') return value;
  throw new ResourceServiceError(400, 'invalid_sync_state');
}
