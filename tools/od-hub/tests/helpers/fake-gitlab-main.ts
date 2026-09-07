// Standalone fake GitLab for the smoke script (`scripts/smoke-login.ts`):
// starts the same node:http fake the unit tests use, seeds Alice and Bob with
// the default groups, prints its origin on the first stdout line, and keeps
// running until SIGTERM/SIGINT.
//
// Approval is driven over a tiny control endpoint so the smoke can act as the
// user clicking "Authorize" in the browser:
//   POST /__fake/approve  {"userCode":"ABCD-0001","userId":101}
import { FakeGitLab } from './fake-gitlab.js';

const ALICE = { id: 101, username: 'alice', name: 'Alice Liddell', email: 'alice@example.test', avatar_url: 'https://gitlab.example.test/alice.png' };
const BOB = { id: 202, username: 'bob', name: 'Bob Builder', email: null, public_email: null };

const gitlab = new FakeGitLab({
  clientId: process.env.GITLAB_OAUTH_CLIENT_ID ?? 'od-hub-smoke-client',
  clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET ?? 'od-hub-smoke-secret',
  interval: 1,
});
gitlab.addUser(ALICE).addUser(BOB);
gitlab.addGroup({ id: 1000, name: 'design', full_name: 'Design Team', full_path: 'design', path: 'design', parent_id: null, avatar_url: 'https://gitlab.example.test/design.png', members: { [ALICE.id]: 50, [BOB.id]: 30 } });
gitlab.addGroup({ id: 2000, name: 'platform', full_name: 'Platform', full_path: 'platform', path: 'platform', parent_id: null, avatar_url: null, members: { [ALICE.id]: 40 } });
gitlab.enableControlEndpoint();

const url = await gitlab.start();
process.stdout.write(`${url}\n`);

const shutdown = () => {
  gitlab.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1 << 30);
