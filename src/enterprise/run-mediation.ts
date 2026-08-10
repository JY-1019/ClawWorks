/**
 * Enterprise run mediation: binds one agent execution to a workflow subtree,
 * evaluates run-start governance, registers the active run for the
 * per-tool-call gate, and persists the run trace. Trace persistence fails
 * open (logged) — only governance enforcement fails closed.
 *
 * runIds recur (fallback retries reuse them; recurring cron sessions reuse
 * their sessionId), so every begin→end cycle gets its own execution_id trace
 * row and the in-memory registry only holds currently-active executions.
 */
import { randomUUID } from "node:crypto";
import {
  failClosedWorkflowSelection,
  selectWorkflowPlan,
  type EnterpriseRouteSelection,
  type WorkflowPlanner,
} from "@openclaw/enterprise-planner";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { adoptEnterpriseActiveRunSessionId } from "./active-runs.js";
import { evaluateRunStartGovernance, resolveGovernancePolicies } from "./governance.js";
import { collectTreeRequiredProperties } from "./ontology-runtime.js";
import {
  buildEnterprisePromptSection,
  buildEnterpriseRunPlan,
  classifyWorkflowTrigger,
  collectWorkflowTreeCandidates,
  enterpriseStepSequence,
  findPlanNode,
  firstUnfinishedStep,
} from "./plan.js";
import {
  enterpriseRunTracksSteps,
  registerEnterpriseActiveRun,
  resolveEnterpriseMcpServers,
  resolveEnterpriseMode,
  unregisterEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "./runtime.js";
import {
  resolveEnterpriseSkillInstructions,
  type AvailableSkill,
  type ResolvedSkillInstructions,
} from "./skill-instructions.js";
import { emitEnterpriseStepEvent } from "./step-events.js";
import {
  appendEnterpriseRunEvent,
  finalizeEnterpriseRun,
  persistEnterpriseRunStart,
  takeEnterpriseRunResume,
  updateEnterpriseRunPlan,
  updateEnterpriseRunSessionId,
} from "./trace-store.sqlite.js";
import { getWorkflowTreeRegistrySnapshot } from "./tree-registry.js";
import type {
  EnterpriseRunEventKind,
  EnterpriseRunPlan,
  EnterpriseRunStatus,
  WorkflowTreeDefinition,
} from "./types.js";

const log = createSubsystemLogger("enterprise");

type MediatedRunState = EnterpriseActiveRun & {
  executionId: string;
  allocateSeq: () => number;
  /**
   * Instructions inlined into this run's digest. Held so a nested begin rebuilds
   * the SAME prompt instead of re-reading (or silently dropping) them.
   */
  skillInstructions?: readonly ResolvedSkillInstructions[];
  /**
   * Whether this RUN walks steps, held for the same reason as the instructions
   * above. A tree tracked only by a node-scoped policy cannot be recognized from
   * the plan alone, so a nested begin that re-derived it would rebuild the digest
   * without the advancement instructions — while the tool stays exposed and
   * required.
   */
  tracksSteps?: boolean;
  /**
   * The conversation this run governs and the agent that owns it, held so live
   * step events can name both. Persisted separately on the trace row; the event
   * needs them in-process. The agent matters because every agent's store shares
   * the canonical `global` session key.
   */
  sessionKey?: string;
  agentId?: string;
};

// Active executions only, keyed by runId (the gate looks runs up by the
// HookContext runId). Entries are removed when the execution ends.
const mediatedRuns = new Map<string, MediatedRunState>();

// Begins that are still awaiting route planning. mediatedRuns is only populated
// AFTER the planner resolves, so without this a second begin for the same runId
// (a nested begin from one runner invocation) would sail past the existing-run
// guard, plan a second time, and create a duplicate execution row that nothing
// ever finalizes.
const pendingBegins = new Map<string, Promise<EnterpriseRunMediation>>();

export type EnterpriseRunMediation =
  | { kind: "off" }
  | { kind: "blocked"; reason: string }
  | { kind: "mediated"; plan: EnterpriseRunPlan; promptSection: string };

export type BeginEnterpriseRunParams = {
  runId: string;
  prompt: string;
  trigger?: string;
  spawnedBy?: string | null;
  sessionKey?: string;
  /**
   * Ephemeral session UUID. Indexed so the loopback MCP server can resolve THIS
   * run from its own trusted sessionId instead of a forgeable run-id header.
   */
  sessionId?: string;
  agentId?: string;
  /**
   * Whether an operator is watching this run in chat. `false` for internal runs
   * that borrow a visible session for storage; their live step events then carry
   * no chat routing, so a hidden run cannot paint over the visible one.
   */
  chatVisible?: boolean;
  /**
   * The runtime continuing earlier work (an exec-approval followup), not the
   * operator asking for something. Such a turn is visible and arrives tagged
   * `trigger: "user"`, so nothing here could tell otherwise; the gateway states
   * it. Resume will not bind to one — an operator arms a run for their NEXT
   * request, and this is not it.
   */
  runtimeContinuation?: boolean;
  config?: OpenClawConfig;
  /**
   * Picks the governing tree and the route through it. Omit to bind the trigger's
   * default tree and plan it whole.
   */
  routePlanner?: WorkflowPlanner;
  /** Cancels the planning call when the agent run is aborted. */
  signal?: AbortSignal;
  /**
   * Skills the runner already resolved for this agent. Used only to inline a
   * declared skill's instructions into the digest, and it is the containment
   * boundary: a step can surface a skill from this set, never add one to it.
   */
  availableSkills?: readonly AvailableSkill[];
  /** Effective `maxSkillsPromptChars`; the inlined bodies answer to it too. */
  maxSkillPromptChars?: number;
  /** Effective `maxSkillsInPrompt`; caps how many bodies may be inlined. */
  maxSkillsInPrompt?: number;
  /** Effective `maxSkillFileBytes`; a skill the loader accepted must be readable. */
  maxSkillFileBytes?: number;
};

/** Begin enterprise mediation for one agent execution. */
export async function beginEnterpriseRun(
  params: BeginEnterpriseRunParams,
): Promise<EnterpriseRunMediation> {
  const inFlight = pendingBegins.get(params.runId);
  if (inFlight) {
    return await inFlight;
  }
  const begin = beginEnterpriseRunInternal(params);
  pendingBegins.set(params.runId, begin);
  try {
    return await begin;
  } finally {
    pendingBegins.delete(params.runId);
  }
}

async function beginEnterpriseRunInternal(
  params: BeginEnterpriseRunParams,
): Promise<EnterpriseRunMediation> {
  // Before the first await, and NOT `plan.createdAt`: the plan is stamped after
  // route planning returns, so a request that was already waiting on the planner
  // when an operator armed a resume would look newer than the marker and consume
  // the one thing meant for their next request. This is when the turn arrived.
  const turnStartedAt = Date.now();
  const mode = resolveEnterpriseMode(params.config);
  if (mode === "off") {
    return { kind: "off" };
  }

  const existing = mediatedRuns.get(params.runId);
  if (existing) {
    // The same execution is still active (nested begin from one runner
    // invocation); reuse it rather than double-tracing.
    return {
      kind: "mediated",
      plan: existing.plan,
      promptSection: buildEnterprisePromptSection(
        existing.plan,
        existing.skillInstructions,
        existing.tracksSteps,
      ),
    };
  }

  // Enforce mode fails closed whenever imported tree definitions may exist
  // but cannot be loaded: running on permissive built-ins would silently
  // drop the org's restrictions. Both failure classes carry an actionable
  // repair path so state-DB repair debt surfaces loudly instead of blocking
  // opaquely; observe/off remain the availability escape hatches.
  const registry = getWorkflowTreeRegistrySnapshot();
  const treeLoadFailure =
    registry.importErrors.length > 0
      ? `imported enterprise workflow trees failed to load: ${registry.importErrors
          .map((entry) => `"${entry.treeId}" (${entry.message})`)
          .join(", ")}; re-import or remove them`
      : registry.storeError
        ? `the enterprise workflow tree store could not be read (${registry.storeError}); repair the state database (openclaw doctor --fix) or relax enterprise.mode to "observe"/"off"`
        : undefined;
  if (treeLoadFailure) {
    if (mode === "enforce") {
      return { kind: "blocked", reason: treeLoadFailure };
    }
    log.warn(`enterprise observe mode continuing on built-in trees: ${treeLoadFailure}`);
  }

  // Only trees an operator IMPORTED can govern a run. Built-ins other than the
  // trigger default ship as EXAMPLES — registered so the Enterprise UI can show
  // a rich work-map without an import step, not so they bind real traffic. They
  // restrict tools per node, and picking a tree is a model judgement now, so
  // nothing else keeps a shipped example off unrelated requests: without this
  // filter the customer-support example governs every stock run, and it also
  // outranks the operator's own work-maps in the fail-closed fallback.
  // Adopting an example means importing it (imports override built-ins by id).
  const trees = registry.entries
    .filter((entry) => entry.source === "imported")
    .map((entry) => entry.tree);
  const trigger = classifyWorkflowTrigger({
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
  });
  const { candidates, defaultTree } = collectWorkflowTreeCandidates({ trigger, trees });
  const policies = resolveGovernancePolicies(params.config);

  const buildPlanFor = (chosen: {
    tree: WorkflowTreeDefinition;
    matchedBy: EnterpriseRunPlan["matchedBy"];
    treeRationale?: string;
    route?: EnterpriseRouteSelection;
  }) => {
    return buildEnterpriseRunPlan({
      runId: params.runId,
      requestText: params.prompt,
      mode,
      ...chosen,
    });
  };

  // Evaluate run-start governance BEFORE any model contact. Planning sends the
  // request text to a provider, so a run a policy denies must be blocked first —
  // otherwise a denied prompt still leaves the machine, and the block is delayed
  // behind a model round-trip.
  //
  // Choosing the tree is ITSELF a model call now, so this check can no longer be
  // scoped to "the" tree — it has to cover every tree the request could bind to.
  // If any candidate denies the run at start, nothing is sent and selection stays
  // deterministic. The decision that actually blocks and gets traced is still the
  // one for the tree finally bound, evaluated below on the real plan.
  const anyCandidateDenied = candidates.some((tree) => {
    const decision = evaluateRunStartGovernance({
      plan: buildPlanFor({ tree, matchedBy: "fallback" }),
      policies,
    });
    return decision.effect === "deny" || decision.effect === "require_approval";
  });
  // The precheck above found a deny/approval, so no planner may run for this
  // turn. Selection must then stay on the tree that policy TARGETS: the deny is
  // re-evaluated below against the bound plan, and binding the permissive default
  // here would make the very policy that withheld the planner miss and let the
  // run through. This is deliberately not treated as planner unavailability.
  const plannerWithheldByGovernance = anyCandidateDenied && mode === "enforce";
  // Only consult (and trace) the planner when one is actually wired. With no
  // planner there is no decision to record, and emitting a route event would make
  // every stock run write trace rows it never wrote before.
  const plannerConsulted = Boolean(params.routePlanner) && !plannerWithheldByGovernance;
  const selection = plannerWithheldByGovernance
    ? failClosedWorkflowSelection({
        trees: candidates,
        defaultTree,
        reason: "run-start governance denied a candidate before planning",
      })
    : await selectWorkflowPlan({
        trees: candidates,
        defaultTree,
        requestText: params.prompt,
        ...(params.routePlanner ? { planner: params.routePlanner } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });

  const plan = buildPlanFor({
    tree: selection.tree,
    matchedBy: selection.treeSource,
    treeRationale: selection.treeRationale,
    ...(plannerConsulted ? { route: selection.route } : {}),
  });
  const startDecision = evaluateRunStartGovernance({ plan, policies });
  const runStartDenied =
    startDecision.effect === "deny" || startDecision.effect === "require_approval";
  const skipPlanning = runStartDenied && mode === "enforce";

  // Route planning can await a provider. If the turn was cancelled while it was
  // in flight, the runner is already tearing the run down — persisting
  // run.started/route.selected now would leave a trace claiming a route for a
  // turn that never ran. Nothing is registered, so nothing needs finalizing.
  if (params.signal?.aborted) {
    return { kind: "off" };
  }

  // Read the declared skills' instructions here: after the cancel guard and the
  // deny shortcut, so a stopped or denied turn never waits on file I/O for a
  // prompt that will not be sent, and before anything is persisted or
  // registered, so a cancellation during the read cannot strand an active run
  // with its trace stuck on "running".
  const skillInstructions = skipPlanning
    ? []
    : await resolveEnterpriseSkillInstructions({
        plan,
        ...(params.availableSkills ? { available: params.availableSkills } : {}),
        ...(params.maxSkillPromptChars !== undefined
          ? { maxPromptChars: params.maxSkillPromptChars }
          : {}),
        ...(params.maxSkillsInPrompt !== undefined ? { maxSkills: params.maxSkillsInPrompt } : {}),
        ...(params.maxSkillFileBytes !== undefined
          ? { maxSkillFileBytes: params.maxSkillFileBytes }
          : {}),
      });

  // Those reads awaited, so a Stop can have arrived since the guard above. Bail
  // before anything is persisted or registered: the CLI runner throws at its own
  // post-mediation abort check before installing its finish handler, which would
  // otherwise leave this run active and its trace stuck on "running" — and a
  // later reuse of the same run id would inherit the stale plan.
  if (params.signal?.aborted) {
    return { kind: "off" };
  }

  let seq = 0;
  const run: MediatedRunState = {
    plan,
    policies,
    mcpServers: resolveEnterpriseMcpServers(params.config),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    // Chat routing for live step events, held only when a chat may show them.
    // An internal run keeps its trace attribution (persisted separately) but
    // publishes no routing, exactly as registerAgentRunContext omits its key.
    ...(params.chatVisible !== false && params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.chatVisible !== false && params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.chatVisible !== false && params.agentId ? { agentId: params.agentId } : {}),
    // Snapshot the tree's required-property shape from the definition this run
    // PLANNED against. Looking it up per tool call would drift: a re-import
    // mid-run invalidates the registry, and an in-flight write would start being
    // judged against a tree the run never planned or prompted against.
    treeRequiredProperties: collectTreeRequiredProperties(selection.tree),
    executionId: randomUUID(),
    allocateSeq: () => seq++,
    sink: (event) => {
      persistTrace(() => {
        appendEvent(run, event.kind, event.nodeId, event.payload);
      });
      // Both kinds land the cursor ON a step: an advance moves it forward, a
      // reopen moves it back onto corrected work. Either way run.plan.activeNodeId
      // was mutated in place, so re-persist the plan or trace reads keep reporting
      // the step the run already left.
      const entersStep = event.kind === "node.entered" || event.kind === "node.reopened";
      if (entersStep) {
        persistTrace(() => {
          updateEnterpriseRunPlan({ executionId: run.executionId, plan: run.plan });
        });
      }
      // Tell live surfaces where the run stands. The trace is durable but it is
      // something you go and read afterwards; a long governed run has to be able
      // to say which step it is on WHILE it runs. Publishing here rather than at
      // the advance site covers the opening step too, which mediation enters
      // itself. Never throws: a listener fault must not affect the run.
      if ((entersStep || event.kind === "node.completed") && event.nodeId !== null) {
        publishStepEvent(run, { ...event, nodeId: event.nodeId });
      }
    },
  };

  persistTrace(() => {
    persistEnterpriseRunStart({
      executionId: run.executionId,
      plan,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      // The transcript link. Held only in the in-memory sessionId->runId index
      // before this, so nothing durable could say which conversation a run's
      // steps belonged to.
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      // Recorded so chat's own lookup can skip it; the session attribution above
      // still stands for audit.
      ...(params.chatVisible === false ? { chatVisible: false } : {}),
    });
  });
  persistTrace(() => {
    appendEvent(run, "run.started", null, {
      treeId: plan.treeId,
      treeVersion: plan.treeVersion,
      matchedBy: plan.matchedBy,
      mode: plan.mode,
    });
  });
  // The route decision is the run's headline: which branch of the tree it took,
  // why, and how much of the tree that covers. Coverage is what makes a wrong
  // route visible (a correct route is a small fraction; a confused one is most
  // of the tree), so it belongs in the trace even when nothing was pruned.
  const routePlan = plan.route;
  if (routePlan) {
    persistTrace(() => {
      appendEvent(run, "route.selected", null, {
        source: routePlan.source,
        routes: routePlan.routes.join(", "),
        rationale: routePlan.rationale,
        selectedNodes: routePlan.selectedNodes,
        totalNodes: routePlan.totalNodes,
        ...(routePlan.invalidRoutes?.length
          ? { invalidRoutes: routePlan.invalidRoutes.join(", ") }
          : {}),
      });
    });
  }

  // Run-level approvals have no interactive channel at run start (the config
  // schema rejects them; this guards programmatic policies), so they compose
  // as deny-equivalent in enforce mode rather than silently passing.
  const runStartBlocked = skipPlanning;
  if (startDecision.source !== "default") {
    // Policy-sourced run decisions (deny, audit, explicit allow) are trace
    // evidence operators configured; only default allows stay silent.
    persistTrace(() => {
      appendEvent(run, "governance.decision", null, {
        subject: "run",
        effect: startDecision.effect,
        enforced: runStartBlocked,
        policyId: startDecision.policyId,
        source: startDecision.source,
        reason: startDecision.reason,
      });
    });
  }
  if (runStartBlocked) {
    persistTrace(() => {
      appendEvent(run, "run.ended", null, { status: "blocked", reason: startDecision.reason });
    });
    persistTrace(() => {
      finalizeEnterpriseRun({ executionId: run.executionId, status: "blocked" });
    });
    return { kind: "blocked", reason: startDecision.reason };
  }

  mediatedRuns.set(params.runId, run);
  registerEnterpriseActiveRun(run);
  // Open the step timeline on the step the plan starts on. The rest of the
  // timeline is written by complete_step as the model walks the route, but the
  // FIRST step is entered by mediation itself — nothing else ever transitions
  // into it, so without this a run that finished one step would trace a
  // `node.completed` for a step it never appeared to enter.
  // Read AFTER registration, and read once: this single answer decides whether the
  // timeline opens, whether the digest tells the model about complete_step, and
  // (through the same predicate) whether the tool is exposed at all. Deriving it
  // separately per surface is how the model ends up told to call a tool it does
  // not have.
  const tracksSteps = enterpriseRunTracksSteps(params.runId);
  const steps = enterpriseStepSequence(plan);
  // Put the cursor on step 1 whenever the RUN tracks steps. buildEnterpriseRunPlan
  // can only see the plan, so a tree tracked solely by a node-scoped policy — no
  // guidance, no descriptions, no audit flag — is left on the root there while the
  // digest built below tells the model it starts on step 1. That gap is not
  // cosmetic: calls made on the first step would be judged against the ROOT rather
  // than the leaf the policy targets, and the first complete_step would merely
  // enter step 1 instead of finishing it.
  // An operator's pending request to continue an earlier execution, consumed
  // once. Resume is never inferred: same session, same work-map, same revision
  // and a previous run left aborted still cannot separate "carry on with that"
  // from "a new request that routes the same way", and guessing wrong opens a
  // run partway through a governed route. Someone has to say so.
  // Only a run the operator could have meant. A work-map whose triggers include
  // `system` also binds to heartbeats and memory flushes in the same session, and
  // one of those arriving first would consume the marker and open mid-route — then
  // the user's actual request, the one the operator queued this for, would start
  // the work-map over. Same for an internal run borrowing a visible session.
  const resumeSessionKey = params.sessionKey;
  const resumeSessionId = params.sessionId;
  const resume =
    trigger === "user" &&
    !params.runtimeContinuation &&
    params.chatVisible !== false &&
    tracksSteps &&
    steps.length > 0 &&
    resumeSessionKey &&
    resumeSessionId
      ? readTrace(() =>
          takeEnterpriseRunResume({
            sessionKey: resumeSessionKey,
            sessionId: resumeSessionId,
            agentId: params.agentId ?? null,
            treeId: plan.treeId,
            // When this turn ARRIVED, so a request already in flight when the
            // operator clicked Continue cannot take a marker armed after it began.
            startedAt: turnStartedAt,
          }),
        )
      : null;
  const resumeStepId = resume ? firstUnfinishedStep(steps, resume.completedNodeIds) : undefined;
  if (tracksSteps && steps.length > 0 && (resumeStepId || !steps.includes(plan.activeNodeId))) {
    plan.activeNodeId = resumeStepId ?? steps[0];
  }
  if (resumeStepId && resume) {
    // Only when the cursor actually moved. The marker is consumed either way (it
    // is one-shot), but a route edited between the two runs can leave nothing to
    // carry over, and tracing `run.resumed` over a run that opened on step 1
    // would describe a restart as a continuation.
    // `openedOn` is the plan's own node id, never model text.
    persistTrace(() => {
      appendEvent(run, "run.resumed", null, {
        resumedFrom: resume.executionId,
        // The cumulative prefix, not a count: the NEXT resume reads this to know
        // what the whole chain finished, so an interruption after this one can
        // still open past work neither run repeated. Step ids are operator-
        // authored, never model text.
        carriedSteps: resume.completedNodeIds,
        openedOn: resumeStepId,
      });
    });
  }
  // A run that tracks no steps must NOT open one. `enterpriseStepSequence` calls a
  // childless root its own single leaf, so a one-node work-map would otherwise be
  // entered here and never completed — nothing can advance it — and every
  // successful single-node run would read as an abandoned step in the trace.
  const openingStep =
    tracksSteps && steps.includes(plan.activeNodeId)
      ? findPlanNode(plan, plan.activeNodeId)
      : undefined;
  if (openingStep) {
    // Through the SINK, not appendEvent: the sink is what re-persists the plan on
    // a node.entered, and the run-start snapshot above was written before the
    // cursor was placed. Appending the event directly would leave the stored plan
    // pointing at the root while the live one stands on step 1.
    run.sink?.({
      kind: "node.entered",
      nodeId: openingStep.nodeId,
      payload: { seq: openingStep.seq, title: openingStep.title },
    });
  }
  run.skillInstructions = skillInstructions;
  run.tracksSteps = tracksSteps;
  return {
    kind: "mediated",
    plan,
    promptSection: buildEnterprisePromptSection(plan, skillInstructions, tracksSteps),
  };
}

/** Finish the active execution for a runId with its terminal outcome. */
export function endEnterpriseRun(params: {
  runId: string;
  status: Exclude<EnterpriseRunStatus, "running">;
  reason?: string;
}): void {
  const run = mediatedRuns.get(params.runId);
  if (!run) {
    return;
  }
  mediatedRuns.delete(params.runId);
  unregisterEnterpriseActiveRun(params.runId);
  // A step the model never finished stays "entered" without a node.completed:
  // run.ended carries the terminal status that closes the run. That asymmetry is
  // the signal — an entered-but-uncompleted step is exactly how an abandoned or
  // interrupted route reads in the trace.
  persistTrace(() => {
    appendEvent(run, "run.ended", null, {
      status: params.status,
      ...(params.reason ? { reason: params.reason } : {}),
    });
  });
  persistTrace(() => {
    finalizeEnterpriseRun({ executionId: run.executionId, status: params.status });
  });
  // Tell live surfaces the run is over. Step transitions alone cannot: a route
  // abandoned mid-step emits no closing transition, and a client that does not
  // own the run has no other way to learn it stopped.
  publishRunEndedEvent(run);
}

function publishRunEndedEvent(run: MediatedRunState): void {
  try {
    const steps = enterpriseStepSequence(run.plan);
    emitEnterpriseStepEvent({
      runId: run.plan.runId,
      executionId: run.executionId,
      ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.agentId ? { agentId: run.agentId } : {}),
      treeId: run.plan.treeId,
      treeName: run.plan.treeName,
      kind: "ended",
      nodeId: run.plan.activeNodeId,
      title: run.plan.treeName,
      ordinal: steps.indexOf(run.plan.activeNodeId) + 1,
      total: steps.length,
    });
  } catch (err) {
    // Fail open, like every other publish here: losing one live update must not
    // take down a run that has already finished its work.
    log.warn(
      `enterprise run ended event publish failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Point a live run's trace at a rotated transcript (overflow/compaction).
 *
 * Both halves move together: the in-memory run, which live step events read, and
 * the durable row, whose `session_id` is documented as the transcript the
 * execution ran against. Updating only one would leave the trace naming a
 * transcript that no longer exists.
 */
export function adoptEnterpriseRunTranscript(runId: string, sessionId: string): void {
  adoptEnterpriseActiveRunSessionId(runId, sessionId, (run) => {
    const execution = mediatedRuns.get(runId);
    if (!execution) {
      return;
    }
    persistTrace(() => {
      updateEnterpriseRunSessionId({ executionId: execution.executionId, sessionId });
    });
    // Keep the mediated copy in step with the registry entry the callback saw.
    execution.sessionId = run.sessionId;
  });
}

/** Test-only: reset mediation state between cases (isolate:false lanes). */
export function clearEnterpriseRunMediationForTest(): void {
  for (const runId of mediatedRuns.keys()) {
    unregisterEnterpriseActiveRun(runId);
  }
  mediatedRuns.clear();
  pendingBegins.clear();
}

/**
 * Publish one step transition to live surfaces.
 *
 * Ordinal/total come from the plan rather than the event payload: the payload
 * carries `seq`, which counts scope containers too, while an operator watching a
 * run wants "step 2 of 4" among the steps it actually executes.
 */
function publishStepEvent(
  run: MediatedRunState,
  event: { kind: string; nodeId: string; payload: Record<string, unknown> },
): void {
  try {
    const steps = enterpriseStepSequence(run.plan);
    const summary = event.payload.summary;
    emitEnterpriseStepEvent({
      runId: run.plan.runId,
      executionId: run.executionId,
      ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.agentId ? { agentId: run.agentId } : {}),
      treeId: run.plan.treeId,
      treeName: run.plan.treeName,
      // A reopen reports as `entered`: what a live surface needs is which step the
      // run is on now, and it is on this one. The durable trace keeps the
      // distinction, so nothing is lost by not widening the live event's shape.
      kind: event.kind === "node.completed" ? "completed" : "entered",
      nodeId: event.nodeId,
      title: typeof event.payload.title === "string" ? event.payload.title : event.nodeId,
      ordinal: steps.indexOf(event.nodeId) + 1,
      total: steps.length,
      ...(typeof summary === "string" ? { summary } : {}),
    });
  } catch (err) {
    // Fail open, like the trace sink: a subscriber that throws must not take the
    // run down, and the operator losing one live update is not worth a failed run.
    log.warn(
      `enterprise step event publish failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function appendEvent(
  run: MediatedRunState,
  kind: EnterpriseRunEventKind,
  nodeId: string | null,
  payload: Record<string, unknown>,
): void {
  appendEnterpriseRunEvent({
    executionId: run.executionId,
    seq: run.allocateSeq(),
    nodeId,
    kind,
    payload,
    createdAt: Date.now(),
  });
}

function persistTrace(write: () => void): void {
  try {
    write();
  } catch (err) {
    log.warn(
      `enterprise trace persistence failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * `persistTrace` for a read that returns something.
 *
 * The trace store fails OPEN: a locked, read-only or corrupt state database must
 * never abort an otherwise valid agent run. Asking whether a resume is pending is
 * still a write transaction (the marker is consumed as it is read), so without
 * this it is the one trace call that could take the run down with it — and the
 * answer it fails to get, "no resume", is the safe one anyway.
 */
function readTrace<T>(read: () => T): T | null {
  try {
    return read();
  } catch (err) {
    log.warn(`enterprise trace read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
