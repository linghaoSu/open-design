// node:http adapter for `CollabHubCore`.
//
// This is the only file in the core that touches sockets. It maps IncomingMessage
// onto `HubRequest` and writes `HubResponse` back, including the SSE sink.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { CollabHubCore } from './hub.ts';
import type { HubRequest, HubResponse } from './types.ts';

export type ListeningHubServer = {
  url: string;
  server: Server;
  close: () => Promise<void>;
};

export function toHubRequest(request: IncomingMessage): HubRequest {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  let bodyPromise: Promise<string> | null = null;
  return {
    method: request.method ?? 'GET',
    path: url.pathname,
    headers,
    readBody: () => {
      bodyPromise ??= readBody(request);
      return bodyPromise;
    },
  };
}

export function writeHubResponse(response: ServerResponse, hubResponse: HubResponse): void {
  if (hubResponse.kind === 'json') {
    response.writeHead(hubResponse.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(hubResponse.body));
    return;
  }
  response.writeHead(hubResponse.status, hubResponse.headers);
  hubResponse.open({
    write: (chunk) => {
      response.write(chunk);
    },
    end: () => response.end(),
    onClose: (callback) => {
      response.req.on('close', callback);
    },
  });
}

export async function listenCollabHub(core: CollabHubCore): Promise<ListeningHubServer> {
  const server = createServer(async (request, response) => {
    writeHubResponse(response, await core.handleRequest(toHubRequest(request)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('fake collaboration hub did not expose a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}
