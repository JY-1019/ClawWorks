/**
 * SQLite persistence for enterprise run traces in the shared state DB.
 * Each mediated execution gets its own execution_id row (runIds recur for
 * fallback retries and recurring cron sessions); events are an append-only
 * (execution_id, seq) log so every governance decision stays attributable to
 * its workflow node.
 */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { getProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { enterpriseStepSequence, firstUnfinishedStep } from "./plan.js";
import type { EnterpriseRunEventKind, EnterpriseRunPlan, EnterpriseRunStatus } from "./types.js";

export type EnterpriseTraceStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDatabasePath?: string;
};

type EnterpriseTraceDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "enterprise_runs" | "enterprise_run_events"
>;

export type EnterpriseRunRecord = {
  executionId: string;
  runId: string;
  sessionKey: string | null;
  /** The transcript this execution ran against; null for rows written before it existed. */
  sessionId: string | null;
  agentId: string | null;
  treeId: string;
  treeVersion: string;
  mode: string;
  status: EnterpriseRunStatus;
  requestSummary: string;
  plan: EnterpriseRunPlan;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** An operator asked for this execution to be continued; not yet consumed. */
  resumeRequested: boolean;
};

export type EnterpriseRunEventRecord = {
  executionId: string;
  seq: number;
  nodeId: string | null;
  kind: EnterpriseRunEventKind;
  payload: Record<string, unknown>;
  createdAt: number;
};

type EnterpriseRunRow = {
  execution_id: string;
  run_id: string;
  session_key: string | null;
  session_id: string | null;
  agent_id: string | null;
  chat_visible: number | null;
  owner_token: string | null;
  resume_requested: number | null;
  tree_id: string;
  tree_version: string;
  mode: string;
  status: string;
  request_summary: string;
  plan_json: string;
  created_at: number | bigint;
  updated_at: number | bigint;
  ended_at: number | bigint | null;
};

const RUN_STATUSES: readonly EnterpriseRunStatus[] = [
  "running",
  "completed",
  "failed",
  "blocked",
  "aborted",
  "timed_out",
];

/**
 * Keyed by the union, not listed as an array, and that is load-bearing.
 *
 * `readonly EnterpriseRunEventKind[]` happily accepts a SHORT list, so a kind
 * added to the union would compile here while `parseRunEventKind` still rejected
 * it. Writes are unvalidated — `appendEnterpriseRunEvent` inserts the kind
 * straight into SQLite — so the omission would surface only on the READ side,
 * throwing for every consumer of that execution's timeline: the Control UI run
 * inspector and `openclaw enterprise runs show` both. A Record makes the same
 * omission a build error instead.
 */
const RUN_EVENT_KINDS = {
  "run.started": true,
  "route.selected": true,
  "run.ended": true,
  "governance.decision": true,
  "node.entered": true,
  "node.completed": true,
  "run.resumed": true,
  "action.invoked": true,
  "run.steered": true,
  "node.reopened": true,
} as const satisfies Record<EnterpriseRunEventKind, true>;

function requireSqliteNumber(value: number | bigint): number {
  return normalizeSqliteNumber(value) ?? 0;
}

function parseRunStatus(value: string): EnterpriseRunStatus {
  const status = RUN_STATUSES.find((candidate) => candidate === value);
  if (!status) {
    throw new Error(`unknown enterprise run status "${value}"`);
  }
  return status;
}

function parseRunEventKind(value: string): EnterpriseRunEventKind {
  if (!Object.hasOwn(RUN_EVENT_KINDS, value)) {
    throw new Error(`unknown enterprise run event kind "${value}"`);
  }
  return value as EnterpriseRunEventKind;
}

function rowToRunRecord(row: EnterpriseRunRow): EnterpriseRunRecord {
  return {
    executionId: row.execution_id,
    runId: row.run_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    agentId: row.agent_id,
    treeId: row.tree_id,
    treeVersion: row.tree_version,
    mode: row.mode,
    status: parseRunStatus(row.status),
    requestSummary: row.request_summary,
    plan: JSON.parse(row.plan_json) as EnterpriseRunPlan,
    createdAt: requireSqliteNumber(row.created_at),
    updatedAt: requireSqliteNumber(row.updated_at),
    endedAt: row.ended_at === null ? null : requireSqliteNumber(row.ended_at),
    resumeRequested: row.resume_requested !== null,
  };
}

function stateDatabaseOptions(options: EnterpriseTraceStoreOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

/** Insert the execution row for one mediated run start as "running". */
export function persistEnterpriseRunStart(
  params: {
    executionId: string;
    plan: EnterpriseRunPlan;
    sessionKey?: string;
    /** Names the transcript this execution ran against. */
    sessionId?: string;
    agentId?: string;
    /** `false` marks a run that must not surface in the session it borrowed. */
    chatVisible?: boolean;
    now?: number;
  },
  options: EnterpriseTraceStoreOptions = {},
): void {
  const now = params.now ?? Date.now();
  const { plan } = params;
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("enterprise_runs").values({
        execution_id: params.executionId,
        run_id: plan.runId,
        session_key: params.sessionKey ?? null,
        session_id: params.sessionId ?? null,
        agent_id: params.agentId ?? null,
        // Only written when hidden; NULL reads as visible, matching every row
        // traced before internal runs were distinguished.
        chat_visible: params.chatVisible === false ? 0 : null,
        // Stamped so orphan cleanup can prove this row's owner is gone. The
        // state DB is shared with `openclaw agent --local` runs.
        owner_token: currentOwnerToken(),
        tree_id: plan.treeId,
        tree_version: plan.treeVersion,
        mode: plan.mode,
        status: "running",
        request_summary: plan.requestSummary,
        plan_json: JSON.stringify(plan),
        created_at: plan.createdAt,
        updated_at: now,
        ended_at: null,
      }),
    );
  }, stateDatabaseOptions(options));
}

/** Append one trace event. Callers own seq allocation (prepared-facts rule). */
export function appendEnterpriseRunEvent(
  event: EnterpriseRunEventRecord,
  options: EnterpriseTraceStoreOptions = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("enterprise_run_events").values({
        execution_id: event.executionId,
        seq: event.seq,
        node_id: event.nodeId,
        kind: event.kind,
        payload_json: JSON.stringify(event.payload),
        created_at: event.createdAt,
      }),
    );
  }, stateDatabaseOptions(options));
}

/**
 * Re-persist plan_json after an in-run mutation. Only the active node advances
 * during a run, so this keeps `enterprise runs show` and the JSON trace
 * reporting the current step instead of the run-start root snapshot.
 */
export function updateEnterpriseRunPlan(
  params: { executionId: string; plan: EnterpriseRunPlan; now?: number },
  options: EnterpriseTraceStoreOptions = {},
): void {
  const now = params.now ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("enterprise_runs")
        .set({ plan_json: JSON.stringify(params.plan), updated_at: now })
        .where("execution_id", "=", params.executionId),
    );
  }, stateDatabaseOptions(options));
}

/** Mark the execution terminal with its final status. */
export function finalizeEnterpriseRun(
  params: { executionId: string; status: Exclude<EnterpriseRunStatus, "running">; now?: number },
  options: EnterpriseTraceStoreOptions = {},
): void {
  const now = params.now ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("enterprise_runs")
        .set({ status: params.status, updated_at: now, ended_at: now })
        .where("execution_id", "=", params.executionId),
    );
  }, stateDatabaseOptions(options));
}

/**
 * Close out runs left `running` by a process that is no longer here.
 *
 * Mediated runs live only in memory, so a row still marked `running` whose
 * OWNING PROCESS is gone can never be finished by anyone: the audit screen would
 * show a run that never ends, and a live surface would seed progress for a run
 * that can never emit another event.
 *
 * Ownership is checked, not assumed. This database is shared — a gateway and an
 * `openclaw agent --local` run write the same table — so sweeping every
 * `running` row would terminate a legitimately live execution's trace.
 *
 * `aborted` is the honest status: the run did not fail on its own terms, it was
 * interrupted. Returns how many rows were closed so startup can log it.
 */
export function abortOrphanedEnterpriseRuns(
  params: { now?: number; isOwnerGone?: (token: string) => boolean } = {},
  options: EnterpriseTraceStoreOptions = {},
): number {
  if (!enterpriseStateDatabaseExists(options)) {
    return 0;
  }
  const now = params.now ?? Date.now();
  const isOwnerGone = params.isOwnerGone ?? isOwnerTokenGone;
  let closed = 0;
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    const running = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("enterprise_runs")
        .select(["execution_id", "owner_token"])
        .where("status", "=", "running"),
    ).rows as { execution_id: string; owner_token: string | null }[];
    // Only rows whose owner is PROVABLY gone. A row with no recorded owner
    // predates the column and is left alone: this database is shared, so guessing
    // would terminate a live `openclaw agent --local` run's trace.
    const orphaned = running.filter((row) => row.owner_token && isOwnerGone(row.owner_token));
    if (orphaned.length === 0) {
      return;
    }
    closed = orphaned.length;
    const executionIds = orphaned.map((row) => row.execution_id);
    const eventRows = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("enterprise_run_events")
        .select(["execution_id", "seq", "kind", "payload_json"])
        .where("execution_id", "in", executionIds),
    ).rows as { execution_id: string; seq: number; kind: string; payload_json: string }[];

    // The run may already have ENDED: finalization appends `run.ended` and
    // updates the summary in two writes, so a process that died between them
    // leaves a terminal event above a `running` row. That run's own verdict
    // stands — overwriting it with `aborted` would corrupt the audit trail and
    // append a second, contradictory terminal event.
    const nextSeq = new Map<string, number>();
    const alreadyEnded = new Map<string, string>();
    for (const row of eventRows) {
      const seq = normalizeSqliteNumber(row.seq) ?? 0;
      nextSeq.set(row.execution_id, Math.max(nextSeq.get(row.execution_id) ?? 0, seq + 1));
      if (row.kind === "run.ended") {
        alreadyEnded.set(row.execution_id, readEndedStatus(row.payload_json));
      }
    }

    for (const executionId of executionIds) {
      const endedStatus = alreadyEnded.get(executionId);
      executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("enterprise_runs")
          .set({ status: endedStatus ?? "aborted", updated_at: now, ended_at: now })
          .where("execution_id", "=", executionId),
      );
      if (endedStatus) {
        continue;
      }
      // Close the append-only trace too. `run.ended` is what normal finalization
      // writes, and both `openclaw enterprise runs show` and the inspector render
      // the event list — a summary that says `aborted` above an event list that
      // never ends reads as a run still in flight.
      executeSqliteQuerySync(
        database.db,
        stateDb.insertInto("enterprise_run_events").values({
          execution_id: executionId,
          seq: nextSeq.get(executionId) ?? 0,
          node_id: null,
          kind: "run.ended",
          payload_json: JSON.stringify({
            status: "aborted",
            reason: RECOVERY_ABORT_REASON,
          }),
          created_at: now,
        }),
      );
    }
  }, stateDatabaseOptions(options));
  return closed;
}

/**
 * The status a already-written `run.ended` event recorded.
 *
 * Falls back to `aborted` only when the payload cannot be read: a terminal event
 * with an unreadable body still proves the run ended, just not how.
 */
function readEndedStatus(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as { status?: unknown };
    return typeof payload.status === "string" && payload.status !== "running"
      ? payload.status
      : "aborted";
  } catch {
    return "aborted";
  }
}

/** This process's incarnation: pid plus, where the OS exposes it, its start time. */
function currentOwnerToken(): string {
  return `${process.pid}:${getProcessStartTime(process.pid) ?? ""}`;
}

/**
 * Whether the process that wrote `token` is provably gone.
 *
 * A bare pid is not enough. A container that restarts hands the new process the
 * same pid (commonly 1), so the crashed run's owner would look alive forever;
 * the recorded start time is what distinguishes the incarnations. Where the OS
 * does not expose a start time (anything but Linux) this falls back to pid
 * liveness, which errs toward leaving rows alone — the safe direction, since the
 * cost of a wrong "gone" is ending a live execution's trace.
 */
function isOwnerTokenGone(token: string): boolean {
  const [pidPart, startedPart = ""] = token.split(":");
  const pid = Number(pidPart);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (isPidDefinitelyDead(pid)) {
    return true;
  }
  // The pid is live, but it may be a different process wearing the same number.
  const recordedStart = startedPart.trim();
  if (!recordedStart) {
    return false;
  }
  const currentStart = getProcessStartTime(pid);
  return currentStart !== null && String(currentStart) !== recordedStart;
}

/**
 * Follow a transcript rotation on the durable row.
 *
 * The in-memory run adopts the new id for live events; without this the trace
 * would still name the pre-compaction transcript, which is exactly what
 * `session_id` is documented to answer.
 */
export function updateEnterpriseRunSessionId(
  params: { executionId: string; sessionId: string; now?: number },
  options: EnterpriseTraceStoreOptions = {},
): void {
  if (!enterpriseStateDatabaseExists(options)) {
    return;
  }
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("enterprise_runs")
        .set({ session_id: params.sessionId, updated_at: params.now ?? Date.now() })
        .where("execution_id", "=", params.executionId),
    );
  }, stateDatabaseOptions(options));
}

/**
 * Reason stamped on runs that startup recovery closed.
 *
 * A shared constant because two places depend on the exact string: recovery
 * writes it, and resume eligibility reads it to tell a crashed run from one an
 * operator actually stopped. They must not drift.
 */
const RECOVERY_ABORT_REASON = "owning process is gone; closed during startup recovery";

/** Read the most recent execution trace for a runId (null when absent). */
export function getEnterpriseRunRecord(
  runId: string,
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunRecord | null {
  if (!enterpriseStateDatabaseExists(options)) {
    return null;
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_runs")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "desc")
      .orderBy("execution_id", "desc")
      .limit(1),
  ) as EnterpriseRunRow | undefined;
  return row ? rowToRunRecord(row) : null;
}

/**
 * Read one execution trace by its execution id (the stable per-execution key).
 * A runId can span multiple executions (fallback retries, recurring cron), so
 * inspection tools resolve a specific listed row by execution id, not runId.
 */
export function getEnterpriseRunRecordByExecutionId(
  executionId: string,
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunRecord | null {
  if (!enterpriseStateDatabaseExists(options)) {
    return null;
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_runs")
      .selectAll()
      .where("execution_id", "=", executionId)
      .limit(1),
  ) as EnterpriseRunRow | undefined;
  return row ? rowToRunRecord(row) : null;
}

/** List every execution recorded for a runId, newest first. */
export function listEnterpriseRunExecutions(
  runId: string,
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunRecord[] {
  if (!enterpriseStateDatabaseExists(options)) {
    return [];
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_runs")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "desc")
      .orderBy("execution_id", "desc"),
  ).rows as EnterpriseRunRow[];
  return rows.map(rowToRunRecord);
}

/** List recent execution traces, newest first. */
export function listEnterpriseRunRecords(
  params: { limit?: number; sessionKey?: string; agentId?: string; chatVisibleOnly?: boolean } = {},
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunRecord[] {
  if (!enterpriseStateDatabaseExists(options)) {
    return [];
  }
  const limit = Math.max(1, Math.min(params.limit ?? 50, 500));
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  // The session filter must be applied in SQL, BEFORE the limit. Filtering the
  // limited page in the client would hide a thread's newest run whenever enough
  // other sessions ran more recently.
  let query = stateDb
    .selectFrom("enterprise_runs")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("execution_id", "desc");
  if (params.sessionKey) {
    query = query.where("session_key", "=", params.sessionKey);
  }
  // Same reason as the session filter, and it is not redundant with it: every
  // agent's store shares the canonical "global" session key, so without this a
  // global thread's newest run can belong to a different agent entirely.
  if (params.agentId) {
    query = query.where("agent_id", "=", params.agentId);
  }
  // Chat asks only for runs an operator is watching. An internal run borrows a
  // visible session for storage, so it matches the filters above and would
  // otherwise be reconstructed into that thread's progress on reconnect. The
  // audit screen does not pass this and still sees everything.
  if (params.chatVisibleOnly) {
    query = query.where((eb) =>
      eb.or([eb("chat_visible", "is", null), eb("chat_visible", "!=", 0)]),
    );
  }
  const rows = executeSqliteQuerySync(database.db, query.limit(limit)).rows as EnterpriseRunRow[];
  return rows.map(rowToRunRecord);
}

/**
 * Every step a run's whole chain finished, derived from its event log.
 *
 * Exported so the detail projection and the resume writer agree: one deciding a
 * run is resumable while the other refuses it would put a button on screen whose
 * only outcome is an error. See `completedNodeIdsFor` for why `run.resumed`
 * carries a prefix.
 */
export function cumulativeCompletedNodeIds(
  events: readonly { kind: string; nodeId: string | null; payload: Record<string, unknown> }[],
): string[] {
  // Replayed in event order, and that ordering is the point: a step can be closed,
  // reopened for a correction, and closed again, so the LAST event about it decides
  // whether it counts as finished. A pass that only collected completions would
  // hand resume a step the run reopened precisely because it was wrong.
  const completed = new Set<string>();
  for (const event of events) {
    if (event.kind === "run.resumed") {
      const carried = event.payload.carriedSteps;
      if (Array.isArray(carried)) {
        for (const step of carried) {
          if (typeof step === "string") {
            completed.add(step);
          }
        }
      }
      continue;
    }
    if (event.kind === "node.reopened") {
      // The whole suffix the reopen invalidated, as the event recorded it. Not
      // just `nodeId`: the completed set has to stay a route PREFIX or
      // firstUnfinishedStep reads the first gap as a finished route.
      const invalidated = event.payload.invalidated;
      if (Array.isArray(invalidated)) {
        for (const step of invalidated) {
          if (typeof step === "string") {
            completed.delete(step);
          }
        }
      }
      continue;
    }
    if (event.kind === "node.completed" && event.nodeId) {
      completed.add(event.nodeId);
    }
  }
  return [...completed];
}

/**
 * Would a request to continue this execution be accepted, and if not, why?
 *
 * The single rule. `requestEnterpriseRunResume` enforces it and the run detail
 * projects it, so the control an operator sees and the answer they get cannot
 * disagree.
 */
export function enterpriseRunResumeRefusal(
  run: {
    status: string;
    sessionKey: string | null;
    sessionId: string | null;
    plan: EnterpriseRunPlan;
  },
  completedNodeIds: readonly string[],
): EnterpriseResumeRefusal | null {
  if (run.status === "running") {
    return "still-running";
  }
  // The TRANSCRIPT as well as the lane. `/new` and `/reset` rebind a session key
  // to a fresh transcript while the key itself stays put, so a marker matched on
  // the key alone could be consumed in a conversation that never saw the steps it
  // claims are done — the resumed run would open past context that is not there.
  // A row predating the column cannot prove which transcript it belongs to, so it
  // is not resumable rather than resumable into the wrong one.
  if (!run.sessionKey || !run.sessionId) {
    return "no-session";
  }
  if (completedNodeIds.length === 0) {
    return "no-steps-completed";
  }
  // Judged against the route this execution actually planned, not its status: a
  // run can end `aborted` with every step done (the provider dropped after the
  // last one), and resuming that has nowhere to open. Mediation would fall back
  // to step 1 and rerun the entire work-map.
  return firstUnfinishedStep(enterpriseStepSequence(run.plan), completedNodeIds)
    ? null
    : "route-complete";
}

export type EnterpriseResumeRefusal =
  | "not-found"
  | "still-running"
  | "no-session"
  | "no-steps-completed"
  | "route-complete"
  | "transcript-rotated";

/**
 * Has this run's conversation been replaced since it ran?
 *
 * `/new` and `/reset` mint a fresh transcript under the same session key, and a
 * marker is bound to the transcript whose steps it continues — so after a
 * rotation no future turn can ever consume it. Detected from the trace itself: a
 * NEWER run in the same lane carrying a different `session_id` is the rotation.
 * Without this the endpoint would accept the request and the screen would wait
 * forever on something that cannot happen.
 *
 * One-directional, like every other scope check here: a rotation this store has
 * not yet seen a run for is not detectable, and the marker simply never fires.
 */
export function enterpriseRunTranscriptRotated(
  run: {
    executionId: string;
    sessionKey: string | null;
    sessionId: string | null;
    agentId: string | null;
    createdAt: number;
  },
  options: EnterpriseTraceStoreOptions = {},
): boolean {
  if (!run.sessionKey || !run.sessionId || !enterpriseStateDatabaseExists(options)) {
    return false;
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const agentId = run.agentId;
  const newer = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_runs")
      .select(["execution_id"])
      .where("session_key", "=", run.sessionKey)
      .where("created_at", ">", run.createdAt)
      .where("session_id", "is not", null)
      .where("session_id", "!=", run.sessionId)
      .where((eb) => (agentId === null ? eb("agent_id", "is", null) : eb("agent_id", "=", agentId)))
      .limit(1),
  ).rows[0] as { execution_id: string } | undefined;
  return newer !== undefined;
}

/** Why a resume request was refused, or the run it will continue. */
export type EnterpriseResumeRequest =
  | { ok: true; sessionKey: string; treeId: string }
  | { ok: false; reason: EnterpriseResumeRefusal };

/**
 * Record an operator's request to continue an execution.
 *
 * Refused for a run still in flight (there is nothing to continue), for one with
 * no session to continue IN, for one that completed no step — a route that never
 * got past its first step resumes to exactly where a fresh run starts, so the
 * marker would only add a claim to the trace that nothing acts on — and for one
 * that finished its WHOLE route, where the same fallback would silently restart
 * the work-map from step 1 and repeat every write it already made.
 */
export function requestEnterpriseRunResume(
  executionId: string,
  params: { now?: number } = {},
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseResumeRequest {
  if (!enterpriseStateDatabaseExists(options)) {
    return { ok: false, reason: "not-found" };
  }
  const armedAt = params.now ?? Date.now();
  let result: EnterpriseResumeRequest = { ok: false, reason: "not-found" };
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    const row = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("enterprise_runs")
        .select([
          "execution_id",
          "session_key",
          "session_id",
          "agent_id",
          "tree_id",
          "status",
          "plan_json",
          "created_at",
        ])
        .where("execution_id", "=", executionId),
    ).rows[0] as
      | {
          execution_id: string;
          session_key: string | null;
          session_id: string | null;
          agent_id: string | null;
          tree_id: string;
          status: string;
          plan_json: string;
          created_at: number | bigint;
        }
      | undefined;
    if (!row) {
      return;
    }
    const completed = completedNodeIdsFor(database.db, stateDb, executionId);
    const refusal = enterpriseRunResumeRefusal(
      {
        status: row.status,
        sessionKey: row.session_key,
        sessionId: row.session_id,
        plan: JSON.parse(row.plan_json) as EnterpriseRunPlan,
      },
      completed,
    );
    // `!sessionKey` is already covered by the refusal above ("no-session"); it is
    // restated so the non-null session key below is a fact rather than a cast.
    const sessionKey = row.session_key;
    if (refusal || !sessionKey) {
      result = { ok: false, reason: refusal ?? "no-session" };
      return;
    }
    if (
      enterpriseRunTranscriptRotated(
        {
          executionId: row.execution_id,
          sessionKey,
          sessionId: row.session_id,
          agentId: row.agent_id,
          createdAt: requireSqliteNumber(row.created_at),
        },
        options,
      )
    ) {
      result = { ok: false, reason: "transcript-rotated" };
      return;
    }
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("enterprise_runs")
        .set({ resume_requested: armedAt })
        .where("execution_id", "=", executionId),
    );
    // One pending resume per AGENT LANE, not per session: under
    // `session.scope: "global"` every agent shares one `session_key`, so keying
    // this on the session alone would let one agent's request clear another's —
    // and, in takeEnterpriseRunResume, be consumed by another agent's next run,
    // opening it partway through steps only the first agent performed. NULL is
    // its own lane and needs IS, which "=" never satisfies in SQL.
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("enterprise_runs")
        .set({ resume_requested: null })
        // Pending rows only. `enterprise_runs` has no retention, so matching the
        // whole lane would rewrite every run this session ever traced — an
        // unbounded write on the shared state DB for what is nearly always a
        // no-op. It also lets the partial pending index serve this.
        .where("resume_requested", "is not", null)
        .where("session_key", "=", sessionKey)
        .where("execution_id", "!=", executionId)
        .where((eb) =>
          row.agent_id === null ? eb("agent_id", "is", null) : eb("agent_id", "=", row.agent_id),
        ),
    );
    result = { ok: true, sessionKey, treeId: row.tree_id };
  }, stateDatabaseOptions(options));
  return result;
}

/**
 * Consume a pending resume for this session and tree, if one is marked.
 *
 * One-shot by design: it clears the marker in the same transaction that reads it,
 * so a resume can never apply twice and a crash between reading and running
 * leaves the operator to ask again rather than silently re-opening a route
 * mid-way. Four things must match, and each closes a way the marker could bind to
 * a turn the operator did not mean:
 *
 * - the TREE, or a request that routes somewhere else is not the work they named;
 * - the AGENT, because a shared `session_key` is not an identity (see
 *   requestEnterpriseRunResume);
 * - the TRANSCRIPT, because `/new` and `/reset` keep the key and change the
 *   conversation, and resuming into one that never saw those steps opens past
 *   context that is not there;
 * - the ORDER, because a turn already in flight when the operator clicked began
 *   before they asked, and "the next request" has to mean the next one.
 */
export function takeEnterpriseRunResume(
  params: {
    sessionKey: string;
    sessionId: string;
    agentId: string | null;
    treeId: string;
    /** When the consuming turn began; only a turn started after arming may take it. */
    startedAt: number;
  },
  options: EnterpriseTraceStoreOptions = {},
): { executionId: string; completedNodeIds: string[] } | null {
  if (!enterpriseStateDatabaseExists(options)) {
    return null;
  }
  let taken: { executionId: string; completedNodeIds: string[] } | null = null;
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    const agentId = params.agentId;
    const row = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("enterprise_runs")
        .select(["execution_id"])
        .where("resume_requested", "is not", null)
        .where("resume_requested", "<", params.startedAt)
        .where("session_key", "=", params.sessionKey)
        .where("session_id", "=", params.sessionId)
        .where("tree_id", "=", params.treeId)
        .where((eb) =>
          agentId === null ? eb("agent_id", "is", null) : eb("agent_id", "=", agentId),
        )
        .orderBy("created_at", "desc")
        .limit(1),
    ).rows[0] as { execution_id: string } | undefined;
    if (!row) {
      return;
    }
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("enterprise_runs")
        .set({ resume_requested: null })
        .where("execution_id", "=", row.execution_id),
    );
    const completedNodeIds = completedNodeIdsFor(database.db, stateDb, row.execution_id);
    if (completedNodeIds.length > 0) {
      taken = { executionId: row.execution_id, completedNodeIds };
    }
  }, stateDatabaseOptions(options));
  return taken;
}

/**
 * Every step finished by this execution AND by the chain it continues.
 *
 * A route can be interrupted more than once: execution 1 finishes step a,
 * execution 2 resumes and finishes b, execution 3 must open on c. Reading only
 * execution 2's own `node.completed` events would see `[b]`, which is not a
 * prefix of the route, so the whole thing would read as unresumable and c could
 * never be reached without redoing a.
 *
 * One hop, not a recursive walk: `run.resumed` carries the cumulative prefix its
 * own run inherited, so each execution's event log already states everything
 * before it.
 */
function completedNodeIdsFor(
  db: DatabaseSync,
  stateDb: Kysely<EnterpriseTraceDatabase>,
  executionId: string,
): string[] {
  const rows = executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("enterprise_run_events")
      .select(["node_id", "kind", "payload_json"])
      .where("execution_id", "=", executionId)
      // `node.reopened` belongs in this narrowing as much as the other two: it is
      // what UNDOES a completion, so filtering it out here would hand the resume
      // writer a prefix that still contains the step a correction reopened.
      .where((eb) =>
        eb.or([
          eb("kind", "=", "node.completed"),
          eb("kind", "=", "node.reopened"),
          eb("kind", "=", "run.resumed"),
        ]),
      )
      .orderBy("seq", "asc"),
  ).rows as { node_id: string | null; kind: string; payload_json: string }[];
  return cumulativeCompletedNodeIds(
    rows.map((row) => ({
      kind: row.kind,
      nodeId: row.node_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    })),
  );
}

/** List one execution's trace events in seq order. */
export function listEnterpriseRunEvents(
  executionId: string,
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunEventRecord[] {
  if (!enterpriseStateDatabaseExists(options)) {
    return [];
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_run_events")
      .selectAll()
      .where("execution_id", "=", executionId)
      .orderBy("seq", "asc"),
  ).rows as Array<{
    execution_id: string;
    seq: number | bigint;
    node_id: string | null;
    kind: string;
    payload_json: string;
    created_at: number | bigint;
  }>;
  return rows.map((row) => ({
    executionId: row.execution_id,
    seq: requireSqliteNumber(row.seq),
    nodeId: row.node_id,
    kind: parseRunEventKind(row.kind),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: requireSqliteNumber(row.created_at),
  }));
}

function enterpriseStateDatabaseExists(options: EnterpriseTraceStoreOptions): boolean {
  if (options.stateDatabasePath) {
    return existsSync(options.stateDatabasePath);
  }
  return existsSync(resolveOpenClawStateSqlitePath(options.env ?? process.env));
}
