// Covers synchronous SQLite transaction helpers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  runSqliteImmediateTransactionSync,
  runSqliteReadTransactionSync,
} from "./sqlite-transaction.js";

const openDatabases: Array<import("node:sqlite").DatabaseSync> = [];
const tempDirs: string[] = [];

function createDatabase(): import("node:sqlite").DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);");
  openDatabases.push(db);
  return db;
}

function readEntries(db: import("node:sqlite").DatabaseSync): string[] {
  return db
    .prepare("SELECT id FROM entries ORDER BY id")
    .all()
    .map((row) => (row as { id: string }).id);
}

function readEntriesByValue(db: import("node:sqlite").DatabaseSync): string[] {
  return db
    .prepare("SELECT value FROM entries ORDER BY value")
    .all()
    .map((row) => (row as { value: string }).value);
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runSqliteReadTransactionSync", () => {
  it("keeps one snapshot when another WAL connection commits between reads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-sqlite-read-"));
    tempDirs.push(dir);
    const pathname = path.join(dir, "state.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const reader = new DatabaseSync(pathname);
    const writer = new DatabaseSync(pathname);
    openDatabases.push(reader, writer);
    reader.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries (value TEXT NOT NULL);");
    writer.exec("PRAGMA journal_mode=WAL; INSERT INTO entries VALUES ('old');");

    const values = runSqliteReadTransactionSync(reader, () => {
      const before = readEntriesByValue(reader);
      runSqliteImmediateTransactionSync(writer, () => {
        writer.exec("DELETE FROM entries; INSERT INTO entries VALUES ('new');");
      });
      return [before, readEntriesByValue(reader)];
    });

    expect(values).toEqual([["old"], ["old"]]);
    expect(readEntriesByValue(reader)).toEqual(["new"]);
  });
});

describe("runSqliteImmediateTransactionSync", () => {
  it("keeps outer writes when a nested savepoint rolls back", () => {
    const db = createDatabase();

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      expect(() =>
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "rolled back");
          throw new Error("nested failure");
        }),
      ).toThrow("nested failure");
    });

    expect(readEntries(db)).toEqual(["outer"]);
  });

  it("commits nested savepoint writes with the outer transaction", () => {
    const db = createDatabase();

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("outer", "kept");
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("inner", "kept");
      });
    });

    expect(readEntries(db)).toEqual(["inner", "outer"]);
  });

  it("rejects Promise-returning operations and rolls back their synchronous writes", () => {
    const db = createDatabase();

    expect(() =>
      runSqliteImmediateTransactionSync(db, async () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("async", "rolled back");
        return "done";
      }),
    ).toThrow("must be synchronous");
    expect(readEntries(db)).toEqual([]);

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("after", "works");
    });
    expect(readEntries(db)).toEqual(["after"]);
  });

  it("retries retryable commit failures without rolling back successful writes", () => {
    const execCalls: string[] = [];
    let commitAttempts = 0;
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (sql === "COMMIT") {
          commitAttempts += 1;
          if (commitAttempts === 1) {
            throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
          }
        }
      },
    } as import("node:sqlite").DatabaseSync;

    const result = runSqliteImmediateTransactionSync(db, () => "committed");

    expect(result).toBe("committed");
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "COMMIT", "COMMIT"]);
  });

  it("rolls back and clears depth after exhausted retryable commit failures", () => {
    const execCalls: string[] = [];
    let failCommits = true;
    const db = {
      exec(sql: string) {
        execCalls.push(sql);
        if (failCommits && sql === "COMMIT") {
          throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
        }
      },
      close() {},
    } as import("node:sqlite").DatabaseSync;

    expect(() => runSqliteImmediateTransactionSync(db, () => "not committed")).toThrow(
      "database is busy",
    );

    expect(execCalls.filter((sql) => sql === "COMMIT")).toHaveLength(8);
    expect(execCalls.at(-1)).toBe("ROLLBACK");

    execCalls.length = 0;
    failCommits = false;
    const result = runSqliteImmediateTransactionSync(db, () => "committed later");

    expect(result).toBe("committed later");
    expect(execCalls).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });
});
