// Generator for the fake `vela` executable.
//
// The script forwards its entire argv (plus stdin for `--requests-file -`) to
// the hub's `/__e2e/command` endpoint and relays `{stdout}` back, so every
// contract decision lives in `handleCommand` rather than in shell text.

import { chmod, writeFile } from 'node:fs/promises';

export function fakeVelaScript(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
let stdin = '';
const requestsFileIndex = args.indexOf('--requests-file');
if (requestsFileIndex >= 0 && args[requestsFileIndex + 1] === '-') {
  for await (const chunk of process.stdin) stdin += chunk;
}
const response = await fetch(new URL('/__e2e/command', process.env.VELA_API_URL), {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + process.env.VELA_CONTROL_KEY,
    'content-type': 'application/json',
    'x-vela-workspace-id': process.env.VELA_WORKSPACE_ID || process.env.OPEN_DESIGN_WORKSPACE_ID || '',
  },
  body: JSON.stringify({ args, stdin }),
});
const payload = await response.json();
if (!response.ok) {
  process.stderr.write(String(payload.message || payload.error || 'fake Vela command failed') + '\\n');
  process.exit(1);
}
process.stdout.write(String(payload.stdout || ''));
`;
}

export async function writeFakeVelaBin(path: string): Promise<string> {
  await writeFile(path, fakeVelaScript(), 'utf8');
  await chmod(path, 0o755);
  return path;
}
