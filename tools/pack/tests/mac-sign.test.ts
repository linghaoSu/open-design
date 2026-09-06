import { describe, expect, it, vi } from "vitest";
import { assertMacDeveloperIdSignature } from "@/mac/sign.js";

const valid = "CodeDirectory v=20500 flags=0x10000(runtime) hashes=1+1\nAuthority=Developer ID Application: Fixture (ABCDEFGHIJ)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDEFGHIJ\n";

describe("final mac distribution signature", () => {
  it("verifies complete contents and Apple's Developer ID requirement before inspecting hardened runtime metadata", async () => {
    const read = vi.fn(async (_args: string[]) => ({ stdout: "", stderr: valid }));
    await expect(assertMacDeveloperIdSignature("/fixture/Design Loom.app", read)).resolves.toBeUndefined();
    expect(read.mock.calls[0]?.[0]).toEqual(["--verify", "--deep", "--strict", "--test-requirement",
      "=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", "/fixture/Design Loom.app"]);
    expect(read.mock.calls[1]?.[0]).toEqual(["--display", "--verbose=4", "/fixture/Design Loom.app"]);
  });

  it.each([
    valid.replace("Developer ID Application:", "Apple Development:"),
    valid.replace("Developer ID Application:", "Self Signed:"),
    valid.replace("TeamIdentifier=ABCDEFGHIJ", "TeamIdentifier=not set"),
    valid.replace("TeamIdentifier=ABCDEFGHIJ\n", ""),
    valid.replace("flags=0x10000(runtime)", "flags=0x0(none)"),
    valid.replace("flags=0x10000(runtime)", "flags=0x10002(adhoc,runtime)"),
    `${valid}Signature=adhoc\n`,
  ])("rejects incomplete or non-distribution signature metadata: %s", async (metadata) => {
    await expect(assertMacDeveloperIdSignature("/fixture/Design Loom.app", async () => ({ stdout: "", stderr: metadata })))
      .rejects.toThrow(/Developer ID Application signature/);
  });

  it("never trusts valid-looking metadata when cryptographic verification fails", async () => {
    const read = vi.fn(async (_args: string[]) => ({ stdout: "", stderr: valid }));
    read.mockRejectedValueOnce(new Error("code has no resources but signature indicates they must be present"));
    await expect(assertMacDeveloperIdSignature("/fixture/Design Loom.app", read)).rejects.toThrow(/signature indicates/);
    expect(read).toHaveBeenCalledOnce();
  });
});
