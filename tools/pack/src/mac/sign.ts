import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
// Apple's Developer ID requirement: an Apple trust anchor, Developer ID issuer,
// and Developer ID Application leaf certificate (Apple TN3127).
const developerIdRequirement = "=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
type ReadCodeSignature = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
const readCodeSignature: ReadCodeSignature = (args) => execute("/usr/bin/codesign", args, {
  encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024,
});

/** Read-only final artifact verification; never accesses private signing keys. */
export async function assertMacDeveloperIdSignature(appPath: string, read: ReadCodeSignature = readCodeSignature): Promise<void> {
  await read(["--verify", "--deep", "--strict", "--test-requirement", developerIdRequirement, appPath]);
  const result = await read(["--display", "--verbose=4", appPath]);
  const metadata = `${result.stdout}\n${result.stderr}`;
  const authority = /^Authority=(.+)$/m.exec(metadata)?.[1];
  const team = /^TeamIdentifier=(.+)$/m.exec(metadata)?.[1];
  const flags = /^CodeDirectory .*\bflags=0x([\da-f]+)/mi.exec(metadata)?.[1];
  if (!authority?.startsWith("Developer ID Application:") || !team || team === "not set"
    || !flags || !(Number.parseInt(flags, 16) & 0x10000) || Number.parseInt(flags, 16) & 0x2
    || /^Signature=adhoc$/m.test(metadata)) {
    throw new Error("tools-pack --signed requires a verified Developer ID Application signature, TeamIdentifier, and hardened runtime");
  }
}
