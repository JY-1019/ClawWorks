import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  deleteOntologyObject,
  getOntologyNeighbors,
  getOntologyObject,
  searchOntologyObjects,
  upsertOntologyLink,
  upsertOntologyObject,
} from "./object-store.sqlite.js";
import { importWorkflowTreeContent, removeImportedWorkflowTree } from "./tree-io.js";
import { invalidateWorkflowTreeRegistry } from "./tree-registry.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-objects-"));
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

const TREE_ID = "test.objects";

const TREE = JSON.stringify({
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: TREE_ID,
  version: "1.0.0",
  name: "Objects",
  root: {
    id: "root",
    title: "Root",
    ontology: {
      entities: [
        {
          id: "claim",
          properties: [
            { id: "claim-id", type: "id", primaryKey: true },
            { id: "amount", type: "number" },
            { id: "status", type: "string" },
          ],
        },
        {
          id: "policy",
          properties: [
            { id: "policy-id", type: "id", primaryKey: true },
            { id: "limit", type: "number" },
          ],
        },
        {
          id: "document",
          properties: [
            { id: "document-id", type: "id", primaryKey: true },
            { id: "verified", type: "boolean" },
          ],
        },
      ],
      relationships: [{ id: "claim-against-policy", from: "claim", to: "policy" }],
    },
  },
});

beforeAll(() => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  invalidateWorkflowTreeRegistry();
  expect(importWorkflowTreeContent({ content: TREE, format: "json" }).ok).toBe(true);
  // Every row is created by a run: a tree declares object TYPES and the actions
  // that write them, never instances.
  runOpenClawStateWriteTransaction((database) => {
    for (const object of [
      {
        entity: "claim",
        objectId: "C-1",
        properties: { "claim-id": "C-1", amount: 100, status: "intake" },
      },
      {
        entity: "claim",
        objectId: "C-2",
        properties: { "claim-id": "C-2", amount: 900, status: "closed" },
      },
      { entity: "policy", objectId: "P-1", properties: { "policy-id": "P-1", limit: 5000 } },
      {
        entity: "document",
        objectId: "D-1",
        properties: { "document-id": "D-1", verified: false },
      },
      { entity: "document", objectId: "D-2", properties: { "document-id": "D-2", verified: true } },
    ]) {
      upsertOntologyObject(database, { treeId: TREE_ID, ...object });
    }
    for (const from of ["C-1", "C-2"]) {
      upsertOntologyLink(database, {
        treeId: TREE_ID,
        relationship: "claim-against-policy",
        fromEntity: "claim",
        fromObjectId: from,
        toEntity: "policy",
        toObjectId: "P-1",
      });
    }
  }, {});
});

afterAll(() => {
  closeOpenClawStateDatabase();
  invalidateWorkflowTreeRegistry();
  rmSync(tempDir, { recursive: true, force: true });
  envSnapshot.restore();
});

describe("object reads", () => {
  it("keys objects by their primaryKey value", () => {
    const claims = searchOntologyObjects({ treeId: TREE_ID, entity: "claim", limit: 10 });
    expect(claims.map((claim) => claim.objectId).toSorted()).toEqual(["C-1", "C-2"]);
    const first = getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-1" });
    expect(first?.properties).toEqual({ "claim-id": "C-1", amount: 100, status: "intake" });
  });

  it("filters on property values in SQL, before the limit", () => {
    // Filtering a limited page in the client would hide a match behind whatever
    // happened to be most recently updated.
    const matched = searchOntologyObjects({
      treeId: TREE_ID,
      entity: "claim",
      match: "closed",
      limit: 10,
    });
    expect(matched.map((claim) => claim.objectId)).toEqual(["C-2"]);
  });

  it("matches boolean and null values by the text the tool actually shows", () => {
    // json_each surfaces `false` as integer 0 and `null` as SQL NULL, so matching
    // the raw value would never find `verified: false` — even though that is
    // exactly what search_objects hands back to the model.
    expect(
      searchOntologyObjects({ treeId: TREE_ID, entity: "document", match: "false", limit: 10 }).map(
        (doc) => doc.objectId,
      ),
    ).toEqual(["D-1"]);
    expect(
      searchOntologyObjects({ treeId: TREE_ID, entity: "document", match: "true", limit: 10 }).map(
        (doc) => doc.objectId,
      ),
    ).toEqual(["D-2"]);
  });

  it("matches property VALUES, not property names", () => {
    // A LIKE over the serialized JSON would also hit the property NAME, so
    // `match: "status"` would return every object that merely HAS a status
    // property. That is not what the tool promises the model.
    expect(
      searchOntologyObjects({ treeId: TREE_ID, entity: "claim", match: "status", limit: 10 }),
    ).toEqual([]);
    // ...while a real value still matches.
    expect(
      searchOntologyObjects({ treeId: TREE_ID, entity: "claim", match: "intake", limit: 10 }).map(
        (claim) => claim.objectId,
      ),
    ).toEqual(["C-1"]);
  });
});

describe("link traversal", () => {
  it("walks a link from either end", () => {
    const fromClaim = getOntologyNeighbors({
      treeId: TREE_ID,
      entity: "claim",
      objectId: "C-1",
      limit: 10,
    });
    expect(fromClaim).toHaveLength(1);
    expect(fromClaim[0]?.direction).toBe("outbound");
    expect(fromClaim[0]?.object?.objectId).toBe("P-1");

    // The same edge read backwards: a link declared claim->policy is equally a
    // fact about the policy, so starting from the policy must find both claims.
    const fromPolicy = getOntologyNeighbors({
      treeId: TREE_ID,
      entity: "policy",
      objectId: "P-1",
      limit: 10,
    });
    expect(
      fromPolicy
        .map((neighbor) => neighbor.object?.objectId ?? "")
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["C-1", "C-2"]);
    expect(fromPolicy.every((neighbor) => neighbor.direction === "inbound")).toBe(true);
  });
});

describe("runtime writes", () => {
  it("updates an object in place", () => {
    runOpenClawStateWriteTransaction((database) => {
      upsertOntologyObject(database, {
        treeId: TREE_ID,
        entity: "claim",
        objectId: "C-1",
        properties: { "claim-id": "C-1", amount: 100, status: "adjudicating" },
      });
    }, {});
    const updated = getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-1" });
    expect(updated?.properties.status).toBe("adjudicating");
  });

  it("keeps what a run created across a re-import", () => {
    runOpenClawStateWriteTransaction((database) => {
      upsertOntologyObject(database, {
        treeId: TREE_ID,
        entity: "claim",
        objectId: "C-9",
        properties: { "claim-id": "C-9", amount: 1, status: "intake" },
      });
    }, {});
    expect(importWorkflowTreeContent({ content: TREE, format: "json" }).ok).toBe(true);
    // A re-import restates the DEFINITION; it must not destroy the data a run
    // created under it.
    expect(getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-9" })).not.toBeNull();
  });

  it("deletes an object together with the edges that touched it", () => {
    runOpenClawStateWriteTransaction((database) => {
      expect(
        deleteOntologyObject(database, { treeId: TREE_ID, entity: "claim", objectId: "C-2" }),
      ).toBe(true);
    }, {});
    expect(getOntologyObject({ treeId: TREE_ID, entity: "claim", objectId: "C-2" })).toBeNull();
    // The C-2 -> P-1 edge would otherwise dangle and get_neighbors would traverse
    // it into nothing.
    const fromPolicy = getOntologyNeighbors({
      treeId: TREE_ID,
      entity: "policy",
      objectId: "P-1",
      limit: 10,
    });
    expect(fromPolicy.map((neighbor) => neighbor.object?.objectId)).toEqual(["C-1"]);
  });
});

describe("tree removal", () => {
  it("takes the tree's objects with it", () => {
    // There is no FK to cascade from (built-in trees are code, not rows), so a
    // missed delete would leave these rows to be inherited by the next tree that
    // claims the id.
    expect(removeImportedWorkflowTree(TREE_ID)).toBe(true);
    expect(searchOntologyObjects({ treeId: TREE_ID, entity: "claim", limit: 10 })).toEqual([]);
    expect(
      getOntologyNeighbors({ treeId: TREE_ID, entity: "policy", objectId: "P-1", limit: 10 }),
    ).toEqual([]);
  });
});
