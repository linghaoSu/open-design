import type { ServerResponse } from 'node:http';

import { ACCESS_REVOKED_MEMBERSHIP_REMOVED, SSE_EVENT_ACCESS_REVOKED, SSE_EVENT_DIRECTORY, SSE_EVENT_WORKSPACE } from '../shared/wire.js';
import type { HubStore, OutboxRow } from './store.js';

export interface SseSubscriber {
  workspaceId: string;
  userId: string;
  memberId: string;
  res: ServerResponse;
  close(): void;
}

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * In-process relay from `events_outbox` to connected SSE streams (PLAN §4.2).
 * Rows are appended by the store inside the mutation transaction; `publish`
 * drains unpublished rows in id order and fans each out:
 *
 *   topic=workspace  -> `event: workspace-event` to every stream of the workspace
 *                       (hub-events-subscriber.ts:663-705 parseHubWorkspaceEvent)
 *   topic=directory  -> `event: workspace-directory-changed` to every stream of the user
 *                       (hub-events-subscriber.ts:632-661)
 *   topic=access     -> `event: access-revoked` to the user's streams of that workspace,
 *                       then those streams are closed (hub-events-subscriber.ts:598-631)
 */
export class EventRelay {
  private readonly subscribers = new Set<SseSubscriber>();
  private draining: Promise<void> | null = null;

  constructor(private readonly store: HubStore, private readonly log: (line: string) => void = () => {}) {}

  subscribe(subscriber: SseSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  get size(): number {
    return this.subscribers.size;
  }

  /** Drain the outbox. Coalesces concurrent callers so publication stays ordered. */
  publish(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const rows = await this.store.listUnpublishedOutbox(500);
      if (rows.length === 0) return;
      for (const row of rows) this.fanOut(row);
      await this.store.markOutboxPublished(rows.map((r) => r.id));
      if (rows.length < 500) return;
    }
  }

  private fanOut(row: OutboxRow): void {
    switch (row.topic) {
      case 'workspace': {
        const frame = sseFrame(SSE_EVENT_WORKSPACE, row.payload);
        for (const sub of this.subscribers) {
          if (sub.workspaceId === row.workspaceId) this.write(sub, frame);
        }
        return;
      }
      case 'directory': {
        const frame = sseFrame(SSE_EVENT_DIRECTORY, row.payload);
        for (const sub of this.subscribers) {
          if (sub.userId === row.userId) this.write(sub, frame);
        }
        return;
      }
      case 'access': {
        const frame = sseFrame(SSE_EVENT_ACCESS_REVOKED, {
          reason: typeof row.payload.reason === 'string' ? row.payload.reason : ACCESS_REVOKED_MEMBERSHIP_REMOVED,
        });
        for (const sub of [...this.subscribers]) {
          if (sub.userId !== row.userId) continue;
          if (row.workspaceId && sub.workspaceId !== row.workspaceId) continue;
          this.write(sub, frame);
          sub.close();
        }
        return;
      }
      default:
        this.log(`[od-hub] outbox row ${row.id} has unknown topic ${String(row.topic)}`);
    }
  }

  private write(sub: SseSubscriber, frame: string): void {
    if (sub.res.destroyed || sub.res.writableEnded) return;
    sub.res.write(frame);
  }

  closeAll(): void {
    for (const sub of [...this.subscribers]) sub.close();
    this.subscribers.clear();
  }
}
