import { crashResult, runCli, type CliResult } from './shim.js';

/**
 * `od-vela` process entry. Writes exactly what the router returns: stdout for
 * payloads, stderr for the single `Error: ...` line, and the exit code. Any
 * unexpected throw goes through `crashResult` so the daemon (which
 * regex-classifies stderr) never sees a Node stack trace.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let result: CliResult;
  try {
    result = await runCli(argv, process.env);
  } catch (error) {
    result = crashResult(argv, error);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

await main();
