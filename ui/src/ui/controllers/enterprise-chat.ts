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
      state.enterpriseChatRunTree = null;
      return;
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
    if (cached?.executionId === mine.executionId && cached.status === mine.status) {
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
    }
  }
}

/** Clear the route card (session switch): a stale route must not stick around. */
export function clearEnterpriseChatRoute(state: EnterpriseChatState) {
  routeSeq++;
  state.enterpriseChatRun = null;
  state.enterpriseChatRunTree = null;
}
