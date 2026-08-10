/**
 * complete_step and reopen_step: the model's half of walking a work-map.
 *
 * Two directions, and only one of them is free. `complete_step` is how a route
 * executes at all, so nothing may withhold it; `reopen_step` walks back onto a
 * step a correction says was wrong, which re-grants a scope the route already
 * left — so it stays an ordinary governed tool. See WORKFLOW_STEP_REOPEN_TOOL.
 *
 * A run bound to a workflow tree executes its route inside ONE tool-calling loop,
 * and this is what moves that loop from one step to the next. Advancement used to
 * be a turn counter owned by the embedded runner, which meant two things that
 * were both wrong: a step needing five turns was abandoned after one (the rest
 * ran under the NEXT step's tools, knowledge and ontology), and every runtime
 * that did not install that hook — CLI, the Codex app-server, ACP — stayed pinned
 * to the root node for its whole life while still being handed the leaves' tools.
 *
 * Making it a tool fixes both at once: whether the work is done is a judgement
 * only the model can make, and any runtime that can call a tool can now walk the
 * route. The tool is exposed for the run's whole life (prompt-cache stability:
 * the model-visible tool list must not change as the run advances) and refuses
 * from an unmediated run, the same way the ontology tools do.
 */
import { Type } from "typebox";
import {
  completeEnterpriseStep,
  reopenEnterpriseStep,
  type EnterpriseStepAdvance,
  type EnterpriseStepReopen,
} from "../../enterprise/runtime.js";
import {
  WORKFLOW_STEP_ADVANCE_TOOL,
  WORKFLOW_STEP_REOPEN_TOOL,
} from "../../enterprise/workflow-control.js";
import { MCP_LOOPBACK_TOOL_CALL_ID_PREFIX } from "../../gateway/mcp-http.protocol.js";
import { asToolParamsRecord, jsonResult, readStringParam, type AnyAgentTool } from "./common.js";

const CompleteStepSchema = Type.Object({
  step: Type.Optional(
    Type.String({
      description:
        "Id of the step you believe you are completing, as shown in the workflow section. Omit to complete whichever step the run is on.",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description:
        "What this step produced, in one or two sentences. Recorded against the step in the run's trace.",
    }),
  ),
});

/**
 * Turn an advance outcome into what the model reads back. Split out so the tool
 * has a single exit and every outcome states where the run now stands — a result
 * that only said "ok" would leave the model guessing which step it is on.
 */
function describeAdvance(
  advance: EnterpriseStepAdvance,
  requestedStep: string | undefined,
): Record<string, unknown> {
  if (advance.kind === "unmediated") {
    return { error: "this run is not governed by a workflow tree, so it has no steps to complete" };
  }
  if (advance.kind === "no-steps") {
    return { error: "this run's workflow has a single scope and no steps to advance through" };
  }
  if (advance.kind === "wrong-step") {
    // Naming where the run actually stands is the whole point: a model that has
    // lost track can correct itself instead of advancing a step it was not
    // working on.
    return {
      error: `this run is on step "${advance.active.nodeId}" (${advance.active.ordinal} of ${advance.active.total}), not "${requestedStep}"`,
      step: advance.active,
    };
  }
  if (advance.kind === "already-complete") {
    return {
      routeComplete: true,
      message: "every step in this run's route is already complete",
      completed: advance.completed,
    };
  }
  if (advance.kind === "route-complete") {
    return {
      routeComplete: true,
      completed: advance.completed,
      message: `completed the final step "${advance.completed.nodeId}"; the route is finished. Answer with the work you have done — there is no further step to enter.`,
    };
  }
  return {
    routeComplete: false,
    ...(advance.completed ? { completed: advance.completed } : {}),
    step: advance.next,
    message: `now on step ${advance.next.ordinal} of ${advance.next.total}: "${advance.next.title}" (${advance.next.nodeId}). Its tools, knowledge sources and constraints are the ones listed under it in the workflow section.`,
  };
}

/**
 * Can this tool-call id anchor a step to the caller's transcript?
 *
 * Only when the CALLER minted it. A loopback id is private to our MCP server and
 * never reaches the client, so a CLI backend's transcript records its own
 * tool-use id instead and nothing would ever match ours.
 */
function isAnchorableToolCallId(toolCallId: string | undefined): toolCallId is string {
  return Boolean(toolCallId) && !toolCallId!.startsWith(MCP_LOOPBACK_TOOL_CALL_ID_PREFIX);
}

export function createCompleteStepTool(opts: { runId: string }): AnyAgentTool {
  return {
    label: "Workflow",
    name: WORKFLOW_STEP_ADVANCE_TOOL,
    // The batch this call arrives in was AUTHORIZED against the node the run was
    // standing on, but this tool moves that node synchronously — and tools like
    // invoke_action re-resolve their scope while they execute. Run in parallel, a
    // sibling could therefore execute under a node governance never approved it
    // for, or keep running after its own step was closed. Sequential mode gates
    // the batch and runs it in model order, which is the only ordering that makes
    // "the active step decided this call" true.
    executionMode: "sequential",
    // States what is true in EVERY mode. Observe mode records out-of-scope calls
    // rather than blocking them, so a flat "later steps are denied" here would
    // contradict the run's own workflow section and discourage calls observe
    // deliberately permits; the mode-specific wording lives there, on the plan
    // that knows the mode.
    description:
      "Finish the current workflow step and move the run onto the next one. Call it when the step's work is genuinely done — it is the only thing that advances the run, and a later step's tools, knowledge sources and constraints apply only once the run reaches it.",
    parameters: CompleteStepSchema,
    execute: async (toolCallId, params) => {
      const record = asToolParamsRecord(params);
      const step = readStringParam(record, "step");
      const summary = readStringParam(record, "summary");
      const advance = completeEnterpriseStep({
        runId: opts.runId,
        // The transcript's toolResult row for THIS call carries the same id, so
        // recording it turns the step timeline from a clock bracket into an exact
        // anchor: everything up to that row belongs to the step just closed.
        //
        // Except on the MCP loopback, where the id is minted by our own server and
        // never returned to the caller — no transcript row can carry it. Storing
        // it would be worse than storing nothing: a join that silently matches
        // zero rows still looks like data.
        ...(isAnchorableToolCallId(toolCallId) ? { toolCallId } : {}),
        ...(step ? { expectedNodeId: step } : {}),
        // Passed through raw: the runtime redacts and bounds it at the
        // persistence boundary, so trimming here would just be a second, weaker
        // owner of the same rule.
        ...(summary ? { summary } : {}),
      });
      return jsonResult(describeAdvance(advance, step));
    },
  };
}

const ReopenStepSchema = Type.Object({
  step: Type.String({
    description:
      "Id of the already-completed step to go back to, as shown in the workflow section.",
  }),
  reason: Type.Optional(
    Type.String({
      description:
        "Why the run is going back, in one sentence. Recorded against the step in the run's trace.",
    }),
  ),
});

/** Turn a reopen outcome into what the model reads back. Mirrors describeAdvance. */
function describeReopen(
  reopen: EnterpriseStepReopen,
  requestedStep: string,
): Record<string, unknown> {
  if (reopen.kind === "unmediated") {
    return { error: "this run is not governed by a workflow tree, so it has no steps to reopen" };
  }
  if (reopen.kind === "no-steps") {
    return { error: "this run's workflow has a single scope and no steps to go back to" };
  }
  if (reopen.kind === "unknown-step") {
    return {
      error: `"${requestedStep}" is not a step in this run's route`,
      steps: reopen.steps,
    };
  }
  if (reopen.kind === "not-behind") {
    // The common miss is aiming at the CURRENT step, which needs no reopening —
    // say so rather than leaving the model to retry the same call.
    return {
      error: `"${requestedStep}" is not behind the run: it is on step "${reopen.active.nodeId}" (${reopen.active.ordinal} of ${reopen.active.total}), and this tool only moves backwards`,
      step: reopen.active,
    };
  }
  if (reopen.kind === "exhausted") {
    // Tell it what to do INSTEAD. A bare refusal invites the same call again, and
    // the whole point of the budget is that this run stops going in circles.
    return {
      error: `this run has already gone back ${reopen.limit} times, which is the limit. Finish the work from step "${reopen.active.nodeId}" and answer with what you have, or report what is still wrong.`,
      step: reopen.active,
    };
  }
  return {
    step: reopen.to,
    reopenedFrom: reopen.from,
    message: `back on step ${reopen.to.ordinal} of ${reopen.to.total}: "${reopen.to.title}" (${reopen.to.nodeId}). Its tools, knowledge sources and constraints apply again; redo the work, then call ${WORKFLOW_STEP_ADVANCE_TOOL} to move forward from here.`,
  };
}

export function createReopenStepTool(opts: { runId: string }): AnyAgentTool {
  return {
    label: "Workflow",
    name: WORKFLOW_STEP_REOPEN_TOOL,
    // Same reason complete_step is sequential: this moves the active node
    // synchronously, and a sibling in the same batch would otherwise execute under
    // a node governance never authorized it for.
    executionMode: "sequential",
    description:
      "Go back to a workflow step this run already finished, when new instructions say that step's work was wrong. Redo the work under that step's own scope, then advance forward again. It only moves backwards.",
    parameters: ReopenStepSchema,
    execute: async (toolCallId, params) => {
      const record = asToolParamsRecord(params);
      const step = readStringParam(record, "step") ?? "";
      const reason = readStringParam(record, "reason");
      const reopen = reopenEnterpriseStep({
        runId: opts.runId,
        nodeId: step,
        // Same anchoring rule as complete_step: a loopback-minted id matches no
        // transcript row, so storing it would be a join that silently finds nothing.
        ...(isAnchorableToolCallId(toolCallId) ? { toolCallId } : {}),
        ...(reason ? { reason } : {}),
      });
      return jsonResult(describeReopen(reopen, step));
    },
  };
}
