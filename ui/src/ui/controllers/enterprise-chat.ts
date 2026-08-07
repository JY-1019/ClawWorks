// Control UI controller for the enterprise surface INSIDE chat: the mode
// selector and the route card for the run the last message produced.
//
// Chat only ever shows the route of the run bound to the CURRENT session, so it
// filters the run list by sessionKey rather than taking "the newest run", which
// would surface another agent's run in this thread.
import type {
  EnterpriseModeGetResult,
  EnterpriseModeSetResult,
  EnterpriseRunDetail,
  EnterpriseRunsGetResult,
  EnterpriseRunsListResult,
  EnterpriseTreeDetail,
  EnterpriseTreesGetResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../gateway.ts";

export type EnterpriseMode = "enforce" | "observe" | "off";

export const ENTERPRISE_MODES: EnterpriseMode[] = ["enforce", "observe", "off"];

export type EnterpriseChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  /** Null until the gateway answers; the selector renders disabled until then. */
  enterpriseChatMode: EnterpriseMode | null;
  enterpriseChatModeBusy: boolean;
  enterpriseChatModeError: string | null;
  /** Route detail of the newest governed run in THIS session, if any. */
  enterpriseChatRun: EnterpriseRunDetail | null;
  /**
   * The FULL tree that run bound to, so the card can show the branches the run
   * did NOT take. Null when the live definition cannot be proven to be the one
   * the run governed (see the hash check) — the route itself still renders.
   */
  enterpriseChatRunTree: EnterpriseTreeDetail | null;
  /**
   * Where a governed run is RIGHT NOW, from the live `enterprise.step` feed.
   *
   * Separate from `enterpriseChatRun`, which is a fetched snapshot: this arrives
   * while the run is still working, which is the whole point — a long route
   * otherwise shows nothing until it finishes. Cleared with the route card, so a
   * finished run's last step never reads as "current".
   */
  enterpriseChatStep: EnterpriseChatStep | null;
};

/** One live step transition, as the chat surface needs it. */
export type EnterpriseChatStep = {
  runId: string;
  /**
   * The begin->end cycle this position belongs to. The identity that matters:
   * runIds recur (retries and recurring cron sessions reuse them), so only this
   * can tell "still the same run" from "a newer run reusing the id".
   */
  executionId: string;
  /**
   * When this position was established (event emit time, or the run's start when
   * seeded from a snapshot). Only ever compared against a run's `createdAt` to
   * answer "is the chip already showing something newer than this run?" — both
   * come from the same gateway clock.
   */
  stamp: number;
  nodeId: string;
  title: string;
  ordinal: number;
  total: number;
  /** `completed` on the final step means the route finished. */
  kind: "entered" | "completed";
};

function isEnterpriseMode(value: unknown): value is EnterpriseMode {
  return value === "enforce" || value === "observe" || value === "off";
}

// A read must never win over a WRITE. Sharing one counter would let a read that
// starts after a write (a reconnect, say) supersede it: the write's own result
// would then be dropped and its `finally` would never clear the busy flag.
//
// So: writes get their own generation. A read only applies when no write has
// started since it began, and a write only applies if it is still the newest.
let modeReadSeq = 0;
let modeWriteSeq = 0;

/** Read the mode the gateway actually enforces (defaults already applied). */
export async function loadEnterpriseChatMode(state: EnterpriseChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  const seq = ++modeReadSeq;
  const writeGeneration = modeWriteSeq;
  try {
    const res = await state.client.request<EnterpriseModeGetResult>("enterprise.mode.get", {});
    // Superseded by a newer read, or by ANY write started since: a write is the
    // operator's intent and a read must not undo it.
    if (seq !== modeReadSeq || writeGeneration !== modeWriteSeq) {
      return;
    }
    state.enterpriseChatMode = isEnterpriseMode(res?.mode) ? res.mode : null;
    state.enterpriseChatModeError = null;
  } catch (err) {
    if (seq !== modeReadSeq || writeGeneration !== modeWriteSeq) {
      return;
    }
    // A token without operator.read simply has no selector; that is not a chat
    // error worth a banner.
    state.enterpriseChatMode = null;
    state.enterpriseChatModeError = String(err);
  }
}

/**
 * Switch the mode. Admin-scoped on the gateway: an operator without admin gets
 * an error back and the selector reverts, rather than showing a mode that was
 * never persisted.
 */
export async function setEnterpriseChatMode(state: EnterpriseChatState, mode: EnterpriseMode) {
  if (!state.client || !state.connected || state.enterpriseChatModeBusy) {
    return;
  }
  const previous = state.enterpriseChatMode;
  // Supersede any in-flight read: its answer predates this switch.
  const seq = ++modeWriteSeq;
  state.enterpriseChatModeBusy = true;
  state.enterpriseChatModeError = null;
  // Optimistic: the selector must not lag a click behind the operator.
  state.enterpriseChatMode = mode;
  try {
    const res = await state.client.request<EnterpriseModeSetResult>("enterprise.mode.set", {
      mode,
    });
    if (seq !== modeWriteSeq) {
      return;
    }
    state.enterpriseChatMode = isEnterpriseMode(res?.mode) ? res.mode : mode;
  } catch (err) {
    if (seq !== modeWriteSeq) {
      return;
    }
    state.enterpriseChatMode = previous;
    state.enterpriseChatModeError = String(err);
  } finally {
    if (seq === modeWriteSeq) {
      state.enterpriseChatModeBusy = false;
    }
  }
}

// Monotonic token: a newer session/turn supersedes an in-flight route load, so a
// late response cannot paint the previous session's route into this thread.
let routeSeq = 0;

/**
 * Load the route of the newest governed run for this session. Called after a
 * turn completes, so the chat can show which branch of the tree the request took.
 */
export async function loadEnterpriseChatRoute(
  state: EnterpriseChatState,
  sessionKey: string,
  agentId?: string,
) {
  if (!state.client || !state.connected || !sessionKey) {
    return;
  }
  const seq = ++routeSeq;
  try {
    // Filter server-side. Fetching the newest N runs and filtering here would
    // lose this thread's run whenever enough other sessions ran more recently.
    // Both filters: under `session.scope: "global"` every agent's store shares
    // the canonical key, so sessionKey alone can return another agent's run.
    const list = await state.client.request<EnterpriseRunsListResult>("enterprise.runs.list", {
      limit: 1,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      // An internal run borrows this session for storage but is not on screen;
      // reconstructing its progress here would surface a deliberately hidden run.
      chatVisibleOnly: true,
    });
    if (seq !== routeSeq) {
      return;
    }
    const mine = list?.runs?.[0];
    if (!mine) {
      state.enterpriseChatRun = null;
      state.enterpriseChatRunTree = null;
      state.enterpriseChatStep = null;
      return;
    }
    // Retire the live position once the run it belongs to is over. Only a step
    // TRANSITION is published, so a run that aborts, errors, or times out mid-route
    // emits no closing event and would otherwise leave "Step 2 of 5" on screen for
    // a dead run indefinitely. This runs after every turn, so the poll is free.
    //
    // Scoped to THIS execution: a newer run's live event can arrive while this
    // load is still awaiting (routeSeq only orders competing loads, not events),
    // and clearing on presence alone would drop the newer run's real progress.
    if (
      state.enterpriseChatStep &&
      mine.status !== "running" &&
      // Identity is not required: this is the NEWEST run in the session, so once
      // it is terminal nothing here is live, and a chip for an older execution
      // (a tab that disconnected across a run boundary) is superseded too.
      // The stamp still guards it, so a transition that arrived after the list
      // call is never undone.
      state.enterpriseChatStep.stamp <= mine.updatedAt
    ) {
      state.enterpriseChatStep = null;
    }
    // Already loaded AND unchanged: this turn produced no NEW governed run
    // (enterprise switched off, or an unmediated turn), so the newest run is still
    // the one on screen.
    //
    // KEEP it. The card is bound to the assistant bubble that run actually wrote,
    // so a later ungoverned answer cannot wear it; clearing here would instead make
    // the correct card vanish from its own bubble until the next reload.
    //
    // Status is part of the identity check: joining a session mid-run caches the run
    // as `running`, and only a COMPLETED run gets a card. An id-only check would
    // skip the terminal refetch and strand it as `running` forever.
    const cached = state.enterpriseChatRun;
    if (
      cached?.executionId === mine.executionId &&
      cached.status === mine.status &&
      // ...but a RUNNING run is never "unchanged": it may have walked several
      // steps since, and a disconnect swallowed those transitions. Refetching is
      // the only way the chip catches up before the run happens to advance again.
      mine.status !== "running"
    ) {
      return;
    }
    const detail = await state.client.request<EnterpriseRunsGetResult>("enterprise.runs.get", {
      executionId: mine.executionId,
    });
    if (seq !== routeSeq) {
      return;
    }
    state.enterpriseChatRun = detail?.run ?? null;
    state.enterpriseChatRunTree = null;
    reconcileEnterpriseChatStep(state, detail?.run ?? null);

    // Load the tree too, so the card can offer "show the whole tree" with the
    // untaken branches dimmed. Identity is proven by CONTENT hash: a version
    // match cannot, since a tree is re-importable unchanged and removing an
    // imported override reveals a different built-in.
    const runDetail = detail?.run;
    const runHash = runDetail?.treeHash;
    if (!runDetail || !runHash) {
      return;
    }
    const treeRes = await state.client
      .request<EnterpriseTreesGetResult>("enterprise.trees.get", {
        treeId: runDetail.treeId,
      })
      .catch(() => null);
    if (seq !== routeSeq) {
      return;
    }
    // The gateway may answer with a STALE fallback tree while reporting importError
    // (the imported override failed to load) or storeError (the store is unreadable);
    // the protocol says such a `tree` is not authoritative. Opening the whole-tree
    // view on it would draw "untaken branches" from a definition the gateway itself
    // does not trust. Route-only is honest; a wrong tree is not.
    const trustworthy = !treeRes?.importError && !treeRes?.storeError;
    const live = trustworthy ? (treeRes?.tree ?? null) : null;
    state.enterpriseChatRunTree = live && live.hash === runHash ? live : null;
  } catch {
    if (seq === routeSeq) {
      state.enterpriseChatRun = null;
      state.enterpriseChatRunTree = null;
      // The chip is a separate surface from the card, so it has to be cleared
      // here too — otherwise a reconnect with reduced scope (or an incompatible
      // gateway) leaves the previous run's position on screen indefinitely.
      state.enterpriseChatStep = null;
    }
  }
}

/** Clear the route card (session switch): a stale route must not stick around. */
/**
 * Reconcile the live position against a freshly fetched run.
 *
 * The step feed publishes transitions only — no replay, and a slow client can be
 * dropped — so joining, reloading, or reconnecting mid-run would otherwise show
 * nothing (or something stale) until the next transition, which on a long step
 * can be minutes away. The run detail is the authority on where the run stands
 * AT FETCH TIME, so the rule is freshness, not identity: whichever of the two
 * observed the run later wins. `stamp` and `updatedAt` both come from the
 * gateway clock, so they are directly comparable.
 */
function reconcileEnterpriseChatStep(state: EnterpriseChatState, run: EnterpriseRunDetail | null) {
  if (!run) {
    return;
  }
  const current = state.enterpriseChatStep;
  // A live event that arrived after this fetch is newer than the snapshot.
  //
  // Both clocks are millisecond `Date.now()`, so a tie is genuinely ambiguous —
  // and a tie ACROSS executions means run B's first step raced this fetch of run
  // A. There the event wins: it was pushed after this request went out. A tie
  // within one execution is harmless either way, so the snapshot may proceed.
  if (current) {
    const observedAt = runObservedAt(run);
    if (
      current.stamp > observedAt ||
      (current.stamp === observedAt && current.executionId !== run.executionId)
    ) {
      return;
    }
  }
  // The run is over — including the case where it went terminal between the list
  // and the detail call, which the summary's status could not see.
  //
  // Identity is not required, for the same reason it is not on the summary path:
  // this is the NEWEST run in the session, the freshness guard above already
  // proved this snapshot is at least as new as the chip, and a terminal newest
  // run means nothing here is live. An older execution's chip (a tab that
  // reconnected across a run boundary) would otherwise never be cleared: the
  // newer run's `ended` is ignored because the ids differ.
  if (run.status !== "running") {
    state.enterpriseChatStep = null;
    return;
  }
  // Only a run THIS gateway is executing can send further transitions. A running
  // row owned by another process (`openclaw agent --local`, a second gateway)
  // would seed a chip that then never moves and never closes, because its events
  // and its `ended` are published in that process, not this one.
  if (!run.locallyActive) {
    // ...and drop what is on screen. The snapshot is fresher than the chip (the
    // freshness gate above already proved that), and this run's transitions and
    // `ended` are published in the process that owns it, so a chip left here
    // would never move and never close.
    state.enterpriseChatStep = null;
    return;
  }
  // Same derivation the publisher uses (enterpriseStepSequence -> leaf nodes),
  // so a seeded ordinal and a live one cannot disagree about "step N of M".
  const parentIds = new Set(run.nodes.map((node) => node.parentId).filter(Boolean));
  const steps = run.nodes.filter((node) => !parentIds.has(node.nodeId));
  const ordinal = steps.findIndex((node) => node.nodeId === run.activeNodeId) + 1;
  if (ordinal < 1 || steps.length === 0) {
    return;
  }
  const active = steps[ordinal - 1];
  state.enterpriseChatStep = {
    runId: run.runId,
    executionId: run.executionId,
    stamp: runObservedAt(run),
    nodeId: run.activeNodeId,
    title: active?.title || run.activeNodeId,
    ordinal,
    total: steps.length,
    // Read from the trace, not the cursor: when the LAST node completes the
    // cursor intentionally stays on it while the agent finishes writing its
    // answer, so assuming `entered` would show "Step N of N" for a route that
    // is actually done.
    kind: latestNodeKind(run, run.activeNodeId),
  };
}

/**
 * How recently this snapshot saw the run.
 *
 * NOT `updatedAt` alone: the trace sink re-persists the plan on `node.entered`
 * only, so a run whose final step COMPLETED still carries the timestamp of the
 * enter before it. A client that missed that completion would then judge its own
 * stale `entered` chip newer than the snapshot proving the route finished.
 */
function runObservedAt(run: EnterpriseRunDetail): number {
  const newestEvent = run.events?.at(-1)?.createdAt ?? 0;
  return Math.max(run.updatedAt, newestEvent);
}

/** Whether the run's newest traced transition for `nodeId` opened or closed it. */
function latestNodeKind(run: EnterpriseRunDetail, nodeId: string): "entered" | "completed" {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const event = run.events[i];
    if (event?.nodeId !== nodeId) {
      continue;
    }
    if (event.kind === "node.completed") {
      return "completed";
    }
    if (event.kind === "node.entered") {
      return "entered";
    }
  }
  return "entered";
}

/**
 * Apply one live step transition, if it belongs to the conversation on screen.
 *
 * Validates rather than trusts the wire: this renders into the chat, so a
 * malformed event should show nothing rather than a broken step counter.
 * Returns whether anything changed, so the caller only re-renders on a real update.
 */
export function applyEnterpriseChatStep(
  state: EnterpriseChatState,
  matchesView: (sessionKey: string | undefined, agentId: string | undefined) => boolean,
  sessionId: string | undefined,
  activeRunId: string | null | undefined,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const evt = payload as Record<string, unknown>;
  const runId = typeof evt.runId === "string" ? evt.runId : "";
  const executionId = typeof evt.executionId === "string" ? evt.executionId : "";
  const stamp = typeof evt.ts === "number" ? evt.ts : 0;
  const nodeId = typeof evt.nodeId === "string" ? evt.nodeId : "";
  const ordinal = typeof evt.ordinal === "number" ? evt.ordinal : 0;
  const total = typeof evt.total === "number" ? evt.total : 0;
  if (!runId || !executionId || !nodeId || total <= 0) {
    return false;
  }
  // The gateway broadcasts every run's steps to every read-scoped client, so the
  // match must be positive: a cron, subagent, or another agent's run would
  // otherwise overwrite the progress for the conversation being watched. The
  // caller owns the comparison because the canonical `global` key is shared by
  // every agent's store, so only host state can tell those runs apart. An event
  // with no session belongs to no conversation and matches nothing.
  const evtSessionKey = typeof evt.sessionKey === "string" ? evt.sessionKey : undefined;
  const evtAgentId = typeof evt.agentId === "string" ? evt.agentId : undefined;
  if (!evtSessionKey || !matchesView(evtSessionKey, evtAgentId)) {
    return false;
  }
  // `sessions.reset` rotates the transcript UUID but KEEPS the session key, so a
  // pre-reset run would otherwise keep reporting into the new, empty chat.
  // Checked only when both sides know their transcript, so an older gateway that
  // does not send one still matches on the key alone.
  //
  // A run ALREADY on screen is exempt: overflow/context-engine compaction rotates
  // a live run's transcript, and the UI's own id lags because history loading is
  // deferred while a run is active. Rejecting there would freeze the chip for the
  // rest of the run. This does not reopen the reset case — reset does not rotate
  // a run's transcript, and the chip is cleared when the route reloads.
  const evtSessionId = typeof evt.sessionId === "string" ? evt.sessionId : undefined;
  // Exempt when this client is the one running it. Two rotations reach here with
  // a transcript the UI has not learned yet: compaction mid-run (a step is
  // already on screen) and the freshness policy rotating at chat.send (nothing
  // on screen yet, so only the owned run id can vouch for it).
  const ownsThisRun =
    state.enterpriseChatStep?.executionId === executionId || activeRunId === runId;
  if (evtSessionId && sessionId && evtSessionId !== sessionId && !ownsThisRun) {
    return false;
  }
  // The run is over. Nothing else says so for a route abandoned mid-step, or for
  // a run this client never owned, so this is the only close signal those get.
  if (evt.kind === "ended") {
    if (state.enterpriseChatStep?.executionId === executionId) {
      state.enterpriseChatStep = null;
      return true;
    }
    return false;
  }
  state.enterpriseChatStep = {
    runId,
    executionId,
    stamp,
    nodeId,
    title: typeof evt.title === "string" && evt.title ? evt.title : nodeId,
    ordinal,
    total,
    kind: evt.kind === "completed" ? "completed" : "entered",
  };
  return true;
}

export function clearEnterpriseChatRoute(state: EnterpriseChatState) {
  routeSeq++;
  state.enterpriseChatRun = null;
  state.enterpriseChatRunTree = null;
  // The live position goes with the card. Keeping it would leave a finished
  // run's last step on screen reading as "current" for the next one.
  state.enterpriseChatStep = null;
}
