import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNativeHookRelayCommand } from "./native-hook-relay.js";

describe("pre-tool relay process boundary", () => {
  it.each(["missing", "crash", "success"])(
    "handles CLI %s without granting on startup failure",
    async (kind) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-command-"));
      try {
        const executable = path.join(dir, "relay.cjs");
        if (kind !== "missing") {
          await fs.writeFile(
            executable,
            kind === "crash"
              ? "process.exit(1)"
              : "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny'}}))",
          );
        }
        const command = buildNativeHookRelayCommand({
          provider: "codex",
          relayId: "test",
          event: "pre_tool_use",
          executable,
          nice: false,
        });
        const result = spawnSync(command, {
          shell: true,
          encoding: "utf8",
          input: "{}",
          timeout: 5000,
        });
        expect(result.status).toBe(kind === "success" ? 0 : 2);
        if (kind === "success") {
          expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
        } else {
          expect(result.stderr).toContain("tool execution blocked");
        }
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
