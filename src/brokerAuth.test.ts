import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOrCreateAgentToken } from "./brokerAuth.ts";

describe("broker agent credential", () => {
  let directory: string;
  let previousOverride: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "swebsy-broker-auth-test-"));
    previousOverride = process.env.SWEBSY_AGENT_AUTH_FILE;
    process.env.SWEBSY_AGENT_AUTH_FILE = join(directory, "agent.token");
  });

  afterEach(async () => {
    if (previousOverride === undefined) {
      delete process.env.SWEBSY_AGENT_AUTH_FILE;
    } else {
      process.env.SWEBSY_AGENT_AUTH_FILE = previousOverride;
    }
    await rm(directory, { recursive: true, force: true });
  });

  it("converges concurrent startups on one private random token", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => readOrCreateAgentToken(37373))
    );

    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a credential readable by another OS user",
    async () => {
      await writeFile(process.env.SWEBSY_AGENT_AUTH_FILE!, "a".repeat(64), {
        mode: 0o644,
      });

      await expect(readOrCreateAgentToken(37373)).rejects.toThrow(
        "is not private"
      );
    }
  );

  it("rejects a persistently malformed credential", async () => {
    await writeFile(process.env.SWEBSY_AGENT_AUTH_FILE!, "known-token", {
      mode: 0o600,
    });

    await expect(readOrCreateAgentToken(37373)).rejects.toThrow(
      "Invalid Swebsy broker credential file"
    );
  });
});
