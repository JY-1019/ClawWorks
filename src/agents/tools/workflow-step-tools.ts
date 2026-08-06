/**
 * complete_step: the model's half of walking a work-map.
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
import { completeEnterpriseStep, type EnterpriseStepAdvance } from "../../enterprise/runtime.js";
import { WORKFLOW_STEP_ADVANCE_TOOL } from "../../enterprise/workflow-control.js";
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
    execute: async (_toolCallId, params) => {
      const record = asToolParamsRecord(params);
      const step = readStringParam(record, "step");
      const summary = readStringParam(record, "summary");
      const advance = completeEnterpriseStep({
        runId: opts.runId,
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
