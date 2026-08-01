// @vitest-environment jsdom
// The mode the Enterprise screens describe enforcement with: it decides whether a
// catalog says "unreachable" or "callable", so reading a draft would describe a
// boundary the gateway is not applying.
import { describe, expect, it } from "vitest";
import { readEnterpriseMode } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";

function makeState(state: Partial<AppViewState>): AppViewState {
  return state as AppViewState;
}

describe("readEnterpriseMode", () => {
  it("prefers the gateway's live answer over an unsaved config edit", () => {
    const mode = readEnterpriseMode(
      makeState({
        enterpriseChatMode: "off",
        configForm: { enterprise: { mode: "enforce" } },
        configSnapshot: {
          config: { enterprise: { mode: "off" } },
        } as AppViewState["configSnapshot"],
      }),
    );

    expect(mode).toBe("off");
  });

  it("ignores a draft edit while the live answer is still missing", () => {
    // The saved snapshot is what the gateway is running until Save/Publish lands.
    const mode = readEnterpriseMode(
      makeState({
        enterpriseChatMode: null,
        configForm: { enterprise: { mode: "enforce" } },
        configSnapshot: {
          config: { enterprise: { mode: "observe" } },
        } as AppViewState["configSnapshot"],
      }),
    );

    expect(mode).toBe("observe");
  });

  it("defaults to enforce with no config and no answer, and to off when redacted", () => {
    expect(readEnterpriseMode(makeState({ enterpriseChatMode: null }))).toBe("enforce");
    expect(readEnterpriseMode(makeState({ enterpriseChatMode: null, configValid: false }))).toBe(
      "off",
    );
  });
});
