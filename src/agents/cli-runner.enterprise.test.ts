/**
 * Proves CLI-backed runtimes sit inside the enterprise governance boundary:
 * a run-level deny blocks runCliAgent before any CLI backend work starts.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearEnterpriseRunMediationForTest } from "../enterprise/run-mediation.js";
import { getEnterpriseRunRecord } from "../enterprise/trace-store.sqlite.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { runCliAgent } from "./cli-runner.js";

afterEach(() => {
  clearEnterpriseRunMediationForTest();
});

afterAll(() => {
  closeOpenClawStateDatabase();
});

describe("runCliAgent — enterprise mediation", () => {
  it("blocks denied runs at run start without touching the CLI backend", async () => {
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [
            {
              id: "deny.everything",
              effect: "deny",
              description: "CLI runtimes are locked down here.",
            },
          ],
        },
      },
    };
    const result = await runCliAgent({
      sessionId: "cli-enterprise-session",
      sessionFile: "/tmp/clawworks-cli-test/session.jsonl",
      workspaceDir: "/tmp/clawworks-cli-test",
      prompt: "hello",
      provider: "claude-cli",
      timeoutMs: 1000,
      runId: "cli-enterprise-run-1",
      config,
    });
    expect(result.meta.error?.kind).toBe("hook_block");
    expect(result.payloads?.[0]).toMatchObject({
      text: "CLI runtimes are locked down here.",
      isError: true,
    });
    expect(getEnterpriseRunRecord("cli-enterprise-run-1")?.status).toBe("blocked");
  });
});
