/**
 * SQLite persistence for enterprise run traces in the shared state DB.
 * Each mediated execution gets its own execution_id row (runIds recur for
 * fallback retries and recurring cron sessions); events are an append-only
 * (execution_id, seq) log so every governance decision stays attributable to
 * its workflow node.
 */
import { existsSync } from "node:fs";
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

const RUN_EVENT_KINDS: readonly EnterpriseRunEventKind[] = [
  "run.started",
  "route.selected",
  "run.ended",
  "governance.decision",
  "node.entered",
  "node.completed",
  "action.invoked",
];

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
  const kind = RUN_EVENT_KINDS.find((candidate) => candidate === value);
  if (!kind) {
    throw new Error(`unknown enterprise run event kind "${value}"`);
  }
  return kind;
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
            reason: "owning process is gone; closed during startup recovery",
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
