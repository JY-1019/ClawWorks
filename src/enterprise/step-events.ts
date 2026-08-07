/**
 * Live step transitions for operator surfaces.
 *
 * The trace already records every transition durably, but a trace is something you
 * go and look at AFTER the fact. A long governed run needs to say where it is WHILE
 * it runs, and the gateway cannot reach into the enterprise layer to ask — so the
 * layer publishes, and the gateway subscribes and broadcasts
 * (src/gateway/server-runtime-subscriptions.ts, the same shape heartbeat uses).
 *
 * Deliberately dependency-free beyond the listener helpers: this is fired from the
 * run's trace sink, which is on the tool-call path.
 */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type EnterpriseStepEventPayload = {
  ts: number;
  /** The agent run. Recurring run ids are fine: executionId disambiguates. */
  runId: string;
  /** This begin→end cycle, matching the trace rows. */
  executionId: string;
  /**
   * Which conversation this run belongs to.
   *
   * The gateway broadcasts every step to every read-scoped client, so a client
   * showing one conversation MUST be able to reject another's steps — a cron or
   * subagent run would otherwise overwrite the progress on screen. Absent for a
   * run with no session (a bare programmatic mediation), which no chat matches.
   */
  sessionKey?: string;
  /**
   * The transcript this run wrote to. `sessions.reset` rotates this UUID while
   * KEEPING the session key, so without it a pre-reset run's progress is
   * indistinguishable from the new conversation's and lingers in an empty chat.
   */
  sessionId?: string;
  /**
   * Which agent ran it. Required to disambiguate the canonical `global` session
   * key, which every agent's store shares — without it one agent's global run
   * matches another's on sessionKey alone.
   */
  agentId?: string;
  treeId: string;
  treeName: string;
  /**
   * `entered` opens a step, `completed` closes it, `ended` closes the RUN.
   *
   * `ended` always fires, including for a route abandoned mid-step, so a live
   * surface never has to infer that a run stopped. Without it a chip belonging
   * to a run this client does not own (another tab, another channel) would sit
   * on "Step 2 of 5" forever, since nothing else tells it the run is over.
   */
  kind: "entered" | "completed" | "ended";
  nodeId: string;
  title: string;
  /** 1-based position among the run's executable steps, and how many there are. */
  ordinal: number;
  total: number;
  /**
   * What the step produced, in the model's words, on `completed` only. Already
   * redacted and bounded where it is recorded (completeEnterpriseStep) — this
   * carries the same value rather than re-deriving it.
   */
  summary?: string;
};

type EnterpriseStepEventState = {
  listeners: Set<(evt: EnterpriseStepEventPayload) => void>;
};

const ENTERPRISE_STEP_EVENT_STATE_KEY = Symbol.for("openclaw.enterpriseStepEvents.state");

const state = resolveGlobalSingleton<EnterpriseStepEventState>(
  ENTERPRISE_STEP_EVENT_STATE_KEY,
  () => ({ listeners: new Set<(evt: EnterpriseStepEventPayload) => void>() }),
);

export function emitEnterpriseStepEvent(evt: Omit<EnterpriseStepEventPayload, "ts">): void {
  // No last-event cache: a step position is only meaningful for a run that is
  // still going, and a late subscriber reading a finished run's last step as
  // "current" would be worse than showing nothing. The trace answers history.
  notifyListeners(state.listeners, { ts: Date.now(), ...evt });
}

export function onEnterpriseStepEvent(
  listener: (evt: EnterpriseStepEventPayload) => void,
): () => void {
  return registerListener(state.listeners, listener);
}

export function resetEnterpriseStepEventsForTest(): void {
  state.listeners.clear();
}
