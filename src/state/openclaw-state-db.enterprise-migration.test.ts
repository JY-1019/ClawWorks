// Covers the enterprise run-trace schema migration: early builds keyed
// enterprise_runs/enterprise_run_events by run_id with no execution_id column,
// which makes the current schema's execution_id index fail on every open. The
// migration drops the transient trace tables so ensureSchema recreates them.
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabase();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clawworks-state-mig-"));
  tempDirs.push(dir);
  return dir;
}

function createLegacyEnterpriseTraceDb(stateDir: string): string {
  const stateDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(stateDatabasePath);
  try {
    // Early-build shape: run_id primary key, no execution_id column.
    db.exec(`
      CREATE TABLE enterprise_runs (
        run_id TEXT NOT NULL PRIMARY KEY,
        tree_id TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE enterprise_run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      INSERT INTO enterprise_runs (run_id, tree_id, plan_json, created_at)
        VALUES ('run-legacy', 'clawworks.assist', '{}', 1);
    `);
  } finally {
    db.close();
  }
  return stateDatabasePath;
}

function tableColumns(dbPath: string, table: string): string[] {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).flatMap(
      (row) => (typeof row.name === "string" ? [row.name] : []),
    );
  } finally {
    db.close();
  }
}

describe("enterprise run-trace schema migration", () => {
  it("detects the legacy run_id-keyed enterprise trace tables", () => {
    const stateDir = makeStateDir();
    createLegacyEnterpriseTraceDb(stateDir);
    const migrations = detectOpenClawStateDatabaseSchemaMigrations({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(migrations.map((migration) => migration.kind)).toContain(
      "enterprise-trace-execution-id-key",
    );
  });

  it("rejects opening a legacy enterprise-trace DB with a doctor repair hint", () => {
    const stateDir = makeStateDir();
    createLegacyEnterpriseTraceDb(stateDir);
    expect(() => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })).toThrow(
      /run openclaw doctor --fix/,
    );
  });

  it("repairs the legacy schema so the tables reopen with execution_id keys", () => {
    const stateDir = makeStateDir();
    const dbPath = createLegacyEnterpriseTraceDb(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };

    const repaired = repairOpenClawStateDatabaseSchema({ env });
    expect(repaired.warnings).toStrictEqual([]);
    expect(repaired.changes).toContain(
      "Rebuilt legacy enterprise run-trace tables → execution_id key",
    );

    // The repair dropped the stale trace tables; ensureSchema recreates them
    // with the canonical execution_id-keyed shape on the next open.
    openOpenClawStateDatabase({ env });
    expect(tableColumns(dbPath, "enterprise_runs")).toContain("execution_id");
    expect(tableColumns(dbPath, "enterprise_run_events")).toContain("execution_id");
    expect(detectOpenClawStateDatabaseSchemaMigrations({ env })).toStrictEqual([]);
  });

  it("leaves a canonical database untouched", () => {
    const stateDir = makeStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    // A fresh open builds the current schema; nothing to migrate afterward.
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabase();
    expect(detectOpenClawStateDatabaseSchemaMigrations({ env })).toStrictEqual([]);
    expect(repairOpenClawStateDatabaseSchema({ env }).changes).toStrictEqual([]);
  });
});
