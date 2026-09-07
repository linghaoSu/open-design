import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { parseHubConfig, resolveBlobDirFlag } from './server/config.js';
import { seedDevIdentity } from './server/dev-seed.js';
import { createHttpGitLabClient, type GitLabClient } from './server/gitlab.js';
import { createHubServer } from './server/http.js';
import { MemoryHubStore, type MemoryHubStoreSeed } from './server/memory-store.js';
import { SqliteHubStore } from './server/sqlite-store.js';
import type { HubStore } from './server/store.js';

const HELP = `od-hub -- self-hosted Vela-compatible hub for OpenDesign

Usage:
  od-hub start [--port <n>] [--host <addr>] [--sqlite <path>] [--blob-dir <dir>]
               [--seed-dev [--control-key <odc_...>]] [--seed <file.json>]

Options:
  --port          TCP port (default: $OD_HUB_PORT or 18790)
  --host          Bind address (default: $OD_HUB_HOST or 127.0.0.1)
  --sqlite        Persist to a better-sqlite3 file instead of memory
  --blob-dir      Root of the content-addressed blob store. Precedence:
                  $BLOB_DIR, then --blob-dir, then <dir of --sqlite>/blobs,
                  then <$OD_HUB_DATA_DIR|.tmp/od-hub>/blobs
  --seed-dev      Create a dev user, personal + team workspace, and a control key.
                  Idempotent, so it is safe to pass on every start of a --sqlite hub.
  --control-key   Plaintext odc_ control key to issue with --seed-dev
                  (default: a fresh random key, printed once on stdout)
  --seed          JSON file of explicit users/workspaces (memory store only)
  -h, --help      Show this help

GitLab login (od-vela login) is enabled when GITLAB_URL and
GITLAB_OAUTH_CLIENT_ID are set; see README.md for the full env table.
Without --seed-dev, --seed, or GitLab the hub starts empty and every bearer is rejected.
`;

interface StartOptions {
  port: number;
  host: string;
  sqlite?: string;
  /** Resolved blob root, or undefined to let `parseHubConfig` pick the env default. */
  blobDir?: string;
  seedDev: boolean;
  controlKey?: string;
  seedFile?: string;
}

export function parseStartArgs(argv: string[], env: NodeJS.ProcessEnv): { command: string; help: boolean; options: StartOptions } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      sqlite: { type: 'string' },
      'blob-dir': { type: 'string' },
      'seed-dev': { type: 'boolean' },
      'control-key': { type: 'string' },
      seed: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const port = Number.parseInt(values.port ?? env.OD_HUB_PORT ?? '18790', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port value`);
  if (values['control-key'] !== undefined && !values['seed-dev']) {
    throw new Error('--control-key requires --seed-dev');
  }
  if (values.seed && values.sqlite) throw new Error('--seed (JSON file) only applies to the in-memory store');
  return {
    command: positionals[0] ?? '',
    help: values.help === true,
    options: {
      port,
      host: values.host ?? env.OD_HUB_HOST ?? '127.0.0.1',
      sqlite: values.sqlite,
      blobDir: resolveBlobDirFlag(values['blob-dir'], values.sqlite, env),
      seedDev: values['seed-dev'] === true,
      controlKey: values['control-key'],
      seedFile: values.seed,
    },
  };
}

async function main(argv: string[]): Promise<number> {
  const { command, help, options } = parseStartArgs(argv, process.env);
  if (help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command !== 'start') {
    process.stderr.write(HELP);
    return 2;
  }

  let store: HubStore;
  if (options.sqlite) {
    store = new SqliteHubStore(options.sqlite);
  } else {
    const seed: MemoryHubStoreSeed = options.seedFile
      ? (JSON.parse(readFileSync(options.seedFile, 'utf8')) as MemoryHubStoreSeed)
      : {};
    store = new MemoryHubStore(seed);
  }

  if (options.seedDev) {
    const seeded = await seedDevIdentity(store, { controlKey: options.controlKey });
    // The plaintext is only recoverable here; a persistent hub prints it once
    // on first issue and afterwards reports the key is already registered.
    process.stdout.write(`${JSON.stringify({
      seeded: {
        userId: seeded.userId,
        personalWorkspaceId: seeded.personalWorkspaceId,
        teamWorkspaceId: seeded.teamWorkspaceId,
        controlKey: seeded.issuedNewKey || options.controlKey ? seeded.controlKey : '(already issued)',
      },
    })}\n`);
  }

  const config = parseHubConfig(process.env);
  if (options.blobDir) config.blobDir = options.blobDir;
  let gitlab: GitLabClient | null = null;
  if (config.gitlabUrl && config.gitlabClientId) {
    gitlab = createHttpGitLabClient({
      baseUrl: config.gitlabUrl,
      clientId: config.gitlabClientId,
      clientSecret: config.gitlabClientSecret,
    });
  } else if (config.gitlabUrl || config.gitlabClientId) {
    process.stderr.write('od-hub: GITLAB_URL and GITLAB_OAUTH_CLIENT_ID must both be set to enable login; login disabled\n');
  }
  if (gitlab && !config.tokenEncKey) {
    process.stderr.write('od-hub: TOKEN_ENC_KEY is not set; GitLab tokens are encrypted with a process-lifetime key and every restart forces re-login\n');
  }

  const hub = createHubServer({ store, gitlab, config, log: (line) => process.stderr.write(`${line}\n`) });
  const { url } = await hub.listen(options.port, options.host);
  process.stdout.write(
    `od-hub listening on ${url} (store: ${options.sqlite ? `sqlite ${options.sqlite}` : 'memory'}, blobs: ${config.blobDir}, gitlab: ${gitlab ? config.gitlabUrl : 'disabled'})\n`,
  );
  const shutdown = () => {
    hub.close().then(() => store.close()).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return -1; // keep running
}

main(process.argv.slice(2)).then((code) => {
  if (code >= 0) process.exit(code);
}, (error) => {
  process.stderr.write(`od-hub: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
