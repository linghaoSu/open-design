import { crashResult, runCli, type CliResult } from './shim.js';

/**
 * `od-vela` process entry. Writes exactly what the router returns: stdout for
 * payloads, stderr for the single `Error: ...` line, and the exit code. Any
 * unexpected throw goes through `crashResult` so the daemon (which
 * regex-classifies stderr) never sees a Node stack trace.
 *
 * `login`/`logout` stream through the `io` sinks so the activation URL reaches
 * the daemon's stdout capture immediately (vela.ts:1463-1470 waits for it)
 * instead of at exit. The daemon spawns us with stdin ignored; nothing here
 * reads stdin.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let result: CliResult;
  try {
    result = await runCli(argv, process.env, {
      io: {
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); },
      },
    });
  } catch (error) {
    result = crashResult(argv, error);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

await main();
