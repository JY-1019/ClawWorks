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
   * Execution id of the run already on screen when the current turn started.
   * If the turn produces no NEW governed run, the newest run is still this one —
   * so the card is cleared rather than claiming the new answer took an old route.
   *
   * Identity, not time: comparing a gateway timestamp against browser Date.now()
   * would misclassify runs whenever the two clocks disagree.
   */
  enterpriseChatRunBefore: string | null;
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
export async function loadEnterpriseChatRoute(state: EnterpriseChatState, sessionKey: string) {
  if (!state.client || !state.connected || !sessionKey) {
    return;
  }
  const seq = ++routeSeq;
  try {
    // Filter server-side. Fetching the newest N runs and filtering here would
    // lose this thread's run whenever enough other sessions ran more recently.
    const list = await state.client.request<EnterpriseRunsListResult>("enterprise.runs.list", {
      limit: 1,
      sessionKey,
    });
    if (seq !== routeSeq) {
      return;
    }
    const mine = list?.runs?.[0];
    if (!mine) {
      state.enterpriseChatRun = null;
      state.enterpriseChatRunBefore = null;
      return;
    }
    // A turn that produced NO new governed run (enterprise switched off, or an
    // unmediated run) leaves the PREVIOUS run as the newest. Showing it would
    // claim this response took a route it never took. Compare identities, not
    // timestamps: a browser-vs-gateway clock skew would misclassify both ways.
    //
    // `baseline` is whatever this loader last saw, so it is set on connect and
    // on session switch too — not only at turn start. Without that, a reconnect
    // would leave it null and the first ungoverned turn would show a stale route.
    if (state.enterpriseChatRunBefore === mine.executionId) {
      state.enterpriseChatRun = null;
      return;
    }
    const detail = await state.client.request<EnterpriseRunsGetResult>("enterprise.runs.get", {
      executionId: mine.executionId,
    });
    if (seq !== routeSeq) {
      return;
    }
    state.enterpriseChatRun = detail?.run ?? null;
    state.enterpriseChatRunBefore = mine.executionId;
  } catch {
    if (seq === routeSeq) {
      state.enterpriseChatRun = null;
    }
  }
}

/**
 * Freeze the baseline at the run currently on screen.
 *
 * A hidden card does NOT mean there is no last-seen run: after one ungoverned
 * turn the card is cleared while its execution id stays the newest one. Nulling
 * the baseline here would make the next ungoverned turn treat that same old run
 * as new and show a stale route, so an existing baseline is preserved.
 */
export function markEnterpriseChatTurnStart(state: EnterpriseChatState) {
  const shown = state.enterpriseChatRun?.executionId;
  if (shown) {
    state.enterpriseChatRunBefore = shown;
  }
}

/** Clear the route card (session switch): a stale route must not stick around. */
export function clearEnterpriseChatRoute(state: EnterpriseChatState) {
  routeSeq++;
  state.enterpriseChatRun = null;
  state.enterpriseChatRunBefore = null;
}
