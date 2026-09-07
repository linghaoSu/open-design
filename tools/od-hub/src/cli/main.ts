import { crashResult, runCli, type CliResult } from './shim.js';

/**
 * `od-vela` process entry. Writes exactly what the router returns: stdout for
 * payloads, stderr for the single `Error: ...` line, and the exit code. Any
 * unexpected throw goes through `crashResult` so the daemon (which
 * regex-classifies stderr) never sees a Node stack trace.
 *
 * `login`/`logout` stream through the `io` sinks so the activation URL reaches
 * the daemon's stdout capture immediately (vela.ts:1463-1470 waits for it)
 * instead of at exit. Only `resource pull-batch --requests-file -` reads
 * stdin (the daemon pipes the request body there, vela-command.ts:342-349);
 * every other command leaves it untouched.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let result: CliResult;
  try {
    result = await runCli(argv, process.env, {
      io: {
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); },
      },
      stdin: readStdin,
    });
  } catch (error) {
    result = crashResult(argv, error);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

await main();
