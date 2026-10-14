import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { EnterpriseRunDetail } from "../../../../packages/gateway-protocol/src/index.js";
import { renderChat, resetChatViewState, resolveEnterpriseRouteGroupKey } from "./chat.ts";

const group = (key: string, role: string, timestamp: number, lastTimestamp = timestamp) => ({
  key,
  role,
  timestamp,
  lastTimestamp,
});

describe("resolveEnterpriseRouteGroupKey", () => {
  it("binds the card to the reply written inside the run's window", () => {
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runStatus: "completed",
        groups: [
          group("g-old", "assistant", 50),
          group("u", "user", 110),
          group("g-run", "assistant", 130),
        ],
      }),
    ).toBe("g-run");
  });

  it("does NOT attach a governed route to a later UNGOVERNED answer", () => {
    // Enterprise switched off mid-thread: runs.list still returns the older
    // governed run on reload. Attaching its route to the newer ungoverned reply
    // would claim that answer took a route it never took.
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runStatus: "completed",
        groups: [
          group("u", "user", 90),
          group("g-run", "assistant", 130),
          group("g-later", "assistant", 900),
        ],
      }),
    ).toBe("g-run");
  });

  it("shows nothing while the reply has not landed yet (it binds on the next render)", () => {
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runStatus: "completed",
        groups: [group("g-old", "assistant", 50)],
      }),
    ).toBeNull();
  });

  it("shows nothing for a run that did not complete (abort/block) — it wrote no reply", () => {
    // Without this, an aborted run would grab whatever answer came next and claim
    // that answer took a route it never took.
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 200,
        runStatus: "aborted",
        groups: [group("g-old", "assistant", 50), group("g-later", "assistant", 900)],
      }),
    ).toBeNull();
  });

  it("binds a CLI-backed reply persisted after the run was stamped ended", () => {
    // endedAt is stamped BEFORE the transcript is written, so the reply can look
    // later than the run. A time-bounded window would drop its card entirely.
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runStatus: "completed",
        groups: [group("u", "user", 90), group("g-reply", "assistant", 999_999)],
      }),
    ).toBe("g-reply");
  });

  it("takes the FIRST reply in the window when a run wrote several", () => {
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runStatus: "completed",
        groups: [
          group("u", "user", 90),
          group("a1", "assistant", 110),
          group("a2", "assistant", 130),
        ],
      }),
    ).toBe("a1");
  });

  it("binds a reply that folded into an OLDER assistant group", () => {
    // Consecutive assistant messages share one group whose `timestamp` is the
    // oldest. Requiring the group to START inside the run window would lose the
    // card for a reply appended to such a group.
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runStatus: "completed",
        groups: [group("u", "user", 40), group("g-folded", "assistant", 40, 130)],
      }),
    ).toBe("g-folded");
  });

  it("still binds when a truncation notice is on screen but the run's reply is visible", () => {
    // The notice carries the BROWSER clock, so it looks newer than the run. Treating
    // it as the oldest thing on screen would hide the card on every long thread.
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runStatus: "completed",
        groups: [
          group("notice", "system", 999_999_999),
          group("u", "user", 90),
          group("g-reply", "assistant", 130),
        ],
      }),
    ).toBe("g-reply");
  });

  it("shows nothing when history is truncated past the run's start", () => {
    // The run's own reply may have been trimmed away; the first visible assistant
    // group would then be some LATER answer, which never took this route.
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runStatus: "completed",
        groups: [group("g-later", "assistant", 900)],
      }),
    ).toBeNull();
  });

  it("keeps a completed route after tool history trims the run's prompt", () => {
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runEndedAt: 200,
        runStatus: "completed",
        groups: [
          group("tools", "tool", 120),
          group("g-reply", "assistant", 190),
          group("u-later", "user", 300),
          group("g-later", "assistant", 400),
        ],
      }),
    ).toBe("g-reply");
  });

  it("does not use retained tool activity to claim a later answer", () => {
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: 100,
        runEndedAt: 200,
        runStatus: "completed",
        groups: [group("tools", "tool", 120), group("g-later", "assistant", 400)],
      }),
    ).toBeNull();
  });

  it("shows nothing without a run", () => {
    expect(
      resolveEnterpriseRouteGroupKey({
        runCreatedAt: null,
        runStatus: "completed",
        groups: [group("g", "assistant", 10)],
      }),
    ).toBeNull();
  });
});

it("retains each answer's route and its disclosure state when another answer arrives", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const run = (executionId: string, createdAt: number): EnterpriseRunDetail => ({
    executionId,
    runId: executionId,
    sessionKey: "route-history",
    agentId: "main",
    treeId: "support",
    treeVersion: "1",
    treeName: executionId,
    mode: "enforce",
    status: "completed",
    matchedBy: "planner",
    requestSummary: "help",
    activeNodeId: "support",
    nodes: [],
    events: [],
    executionCount: 1,
    createdAt,
    updatedAt: createdAt + 10,
    endedAt: createdAt + 10,
  });
  const message = (role: string, timestamp: number) => ({
    role,
    timestamp,
    content: [{ type: "text", text: `${role} ${timestamp}` }],
  });
  const first = { run: run("first", 100), tree: null };
  const second = { run: run("second", 300), tree: null };
  const props: Parameters<typeof renderChat>[0] = {
    sessionKey: "route-history",
    onSessionKeyChange() {},
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: false,
    loading: false,
    sending: false,
    messages: [message("user", 90), message("assistant", 110)],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: null,
    assistantName: "Assistant",
    assistantAvatar: null,
    agentsList: null,
    currentAgentId: "main",
    onRefresh() {},
    onDraftChange() {},
    onSend() {},
    onQueueRemove() {},
    onNewSession() {},
    onAgentChange() {},
    enterpriseRoutes: [first],
  };
  try {
    render(renderChat(props), container);
    const original = container.querySelector("openclaw-chat-route-card")!;
    await original.updateComplete;
    original.shadowRoot!.querySelector("summary")!.click();
    render(
      renderChat({
        ...props,
        messages: [...props.messages, message("user", 290), message("assistant", 310)],
        enterpriseRoutes: [first, second],
      }),
      container,
    );
    const cards = container.querySelectorAll("openclaw-chat-route-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toBe(original);
    expect(cards[0].run?.executionId).toBe("first");
    expect(cards[1].run?.executionId).toBe("second");
    expect(original.shadowRoot!.querySelector("details")!.open).toBe(false);
  } finally {
    render(null, container);
    container.remove();
    resetChatViewState();
  }
});
