import { MemoryHubStore, type MemoryHubStoreSeed } from '../src/server/memory-store.js';
import { createHubServer, type HubServer } from '../src/server/http.js';

export const CONTROL_KEY = 'odc_test_key_alice';
export const OTHER_KEY = 'odc_test_key_bob';
export const TEAM_WORKSPACE = 'g42';
export const PERSONAL_WORKSPACE = 'u1';

export const SEED: MemoryHubStoreSeed = {
      users: [
        { id: 'u1', email: 'alice@example.test', name: 'Alice', controlKey: CONTROL_KEY },
        { id: 'u2', email: 'bob@example.test', name: 'Bob', controlKey: OTHER_KEY },
      ],
      workspaces: [
        { id: PERSONAL_WORKSPACE, name: "Alice's workspace", kind: 'personal', members: [{ userId: 'u1', role: 'owner' }] },
        {
          id: TEAM_WORKSPACE,
          name: 'Design Team',
          kind: 'team',
          iconKey: 'https://gitlab.example.test/avatar.png',
          members: [
            { userId: 'u1', role: 'owner' },
            { userId: 'u2', role: 'member' },
          ],
        },
      ],
};

export function seededStore(): MemoryHubStore {
  return new MemoryHubStore(SEED, { now: () => new Date('2026-09-08T00:00:00.000Z') });
}

export async function startHub(store = seededStore()): Promise<{ hub: HubServer; url: string; store: MemoryHubStore }> {
  const hub = createHubServer({ store, heartbeatIntervalMs: 50 });
  const { url } = await hub.listen(0);
  return { hub, url, store };
}

export function authHeaders(key = CONTROL_KEY, workspaceId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (workspaceId) headers['x-vela-workspace-id'] = workspaceId;
  return headers;
}

/** Read SSE frames until `count` events have been parsed, then abort. */
export async function readSseEvents(
  url: string,
  headers: Record<string, string>,
  count: number,
): Promise<Array<{ event: string; data: unknown }>> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`sse status ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<{ event: string; data: unknown }> = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
      events.push({ event, data: JSON.parse(data) });
      boundary = buffer.indexOf('\n\n');
    }
  }
  controller.abort();
  return events.slice(0, count);
}
