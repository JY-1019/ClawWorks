// Control UI controller manages the enterprise inspection gateway state.
import type {
  EnterpriseRunDetail,
  EnterpriseRunsGetResult,
  EnterpriseRunsListResult,
  EnterpriseRunSummary,
  EnterpriseTreeSummary,
  EnterpriseTreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type EnterpriseState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enterpriseLoading: boolean;
  enterpriseRuns: EnterpriseRunSummary[];
  enterpriseTrees: EnterpriseTreeSummary[];
  enterpriseImportErrors: EnterpriseTreesListResult["importErrors"];
  enterpriseStoreError: string | null;
  enterpriseSelectedExecutionId: string | null;
  enterpriseDetail: EnterpriseRunDetail | null;
  enterpriseDetailLoading: boolean;
  enterpriseError: string | null;
};

/** Load the recent-run list and the workflow-tree registry for the tab. */
export async function loadEnterprise(state: EnterpriseState) {
  if (!state.client || !state.connected || state.enterpriseLoading) {
    return;
  }
  state.enterpriseLoading = true;
  state.enterpriseError = null;
  try {
    const [runs, trees] = await Promise.all([
      state.client.request<EnterpriseRunsListResult>("enterprise.runs.list", {}),
      state.client.request<EnterpriseTreesListResult>("enterprise.trees.list", {}),
    ]);
    state.enterpriseRuns = runs.runs;
    state.enterpriseTrees = trees.trees;
    state.enterpriseImportErrors = trees.importErrors;
    state.enterpriseStoreError = trees.storeError ?? null;
  } catch (err) {
    applyError(state, err);
  } finally {
    state.enterpriseLoading = false;
  }
}

// Monotonic token so only the latest detail request wins. The selected id alone
// can't disambiguate two in-flight requests for the SAME run (double click, or
// Refresh while a detail load is pending), and gateway responses can resolve out
// of order, so a bare id check would let an older response overwrite a newer one.
let detailRequestSeq = 0;

/** Fetch one execution's plan + governance trace for the inspector panel. */
export async function loadEnterpriseRunDetail(state: EnterpriseState, executionId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++detailRequestSeq;
  state.enterpriseSelectedExecutionId = executionId;
  state.enterpriseDetail = null;
  state.enterpriseDetailLoading = true;
  state.enterpriseError = null;
  try {
    const res = await state.client.request<EnterpriseRunsGetResult>("enterprise.runs.get", {
      executionId,
    });
    // Drop the response if a newer detail request has since started.
    if (requestSeq !== detailRequestSeq) {
      return;
    }
    state.enterpriseDetail = res.run;
  } catch (err) {
    if (requestSeq !== detailRequestSeq) {
      return;
    }
    applyError(state, err);
  } finally {
    // Only the latest request owns the loading flag; an older one clearing it
    // would hide the newer request's in-flight state.
    if (requestSeq === detailRequestSeq) {
      state.enterpriseDetailLoading = false;
    }
  }
}

/** Reload the list + registry and, when one is open, the selected run detail. */
export async function refreshEnterprise(state: EnterpriseState) {
  await loadEnterprise(state);
  // If the list/tree refresh failed, keep its error banner; a following detail
  // reload would clear enterpriseError and hide the stale-list failure. (An auth
  // failure also clears the selection, so the guard below would skip anyway.)
  if (state.enterpriseError) {
    return;
  }
  const selected = state.enterpriseSelectedExecutionId;
  if (selected) {
    await loadEnterpriseRunDetail(state, selected);
  }
}

function applyError(state: EnterpriseState, err: unknown) {
  if (isMissingOperatorReadScopeError(err)) {
    // A downgraded/reconnected token without operator.read must not keep prior
    // governed run data on screen under the error banner.
    state.enterpriseRuns = [];
    state.enterpriseTrees = [];
    state.enterpriseImportErrors = [];
    state.enterpriseStoreError = null;
    state.enterpriseSelectedExecutionId = null;
    state.enterpriseDetail = null;
    state.enterpriseDetailLoading = false;
    state.enterpriseError = formatMissingOperatorReadScopeMessage("enterprise runs");
    return;
  }
  state.enterpriseError = String(err);
}
