/**
 * Process-stable workflow tree registry: built-in trees plus imported
 * definitions from the shared state DB. Loaded once per process (hot paths
 * carry the snapshot forward — no per-run DB reads); imports through this
 * process invalidate the snapshot, imports from other processes (CLI vs
 * gateway) follow the restart/reload contract like plugin metadata.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { BUILTIN_WORKFLOW_TREES } from "./builtin-trees.js";
import {
  listEnterpriseWorkflowTrees,
  type EnterpriseTreeStoreOptions,
} from "./tree-store.sqlite.js";
import type { WorkflowTreeDefinition } from "./types.js";

const log = createSubsystemLogger("enterprise");

export type WorkflowTreeRegistryEntry = {
  tree: WorkflowTreeDefinition;
  /** Where the runtime definition came from. Imports override builtins by id. */
  source: "builtin" | "imported";
};

export type WorkflowTreeRegistrySnapshot = {
  entries: WorkflowTreeRegistryEntry[];
  /**
   * Imports that provably exist but failed to load (corrupt rows). Their
   * restrictions are lost, so enforce-mode mediation fails closed on these
   * instead of silently running permissive built-ins.
   */
  importErrors: Array<{ treeId: string; message: string }>;
  /**
   * Whole-store read failure (unreadable/legacy state DB). Imports may be
   * hidden behind it, so enforce-mode mediation also fails closed on this —
   * with a doctor-repair hint — while observe mode continues on built-ins.
   */
  storeError?: string;
};

// Symbol-keyed global so duplicated dist chunks share one snapshot.
const REGISTRY_KEY = Symbol.for("openclaw.enterpriseTreeRegistry");

type RegistryHolder = { snapshot?: WorkflowTreeRegistrySnapshot };

function holder(): RegistryHolder {
  const globals = globalThis as { [REGISTRY_KEY]?: RegistryHolder };
  globals[REGISTRY_KEY] ??= {};
  return globals[REGISTRY_KEY];
}

function loadRegistry(options: EnterpriseTreeStoreOptions): WorkflowTreeRegistrySnapshot {
  const entries = new Map<string, WorkflowTreeRegistryEntry>();
  for (const tree of BUILTIN_WORKFLOW_TREES) {
    entries.set(tree.id, { tree, source: "builtin" });
  }
  let importErrors: Array<{ treeId: string; message: string }> = [];
  let storeError: string | undefined;
  try {
    const read = listEnterpriseWorkflowTrees(options);
    importErrors = read.rowErrors;
    for (const { treeId, message } of read.rowErrors) {
      log.warn(`enterprise workflow tree "${treeId}" failed to load: ${message}`);
    }
    for (const record of read.records) {
      entries.set(record.tree.id, { tree: record.tree, source: "imported" });
    }
  } catch (err) {
    storeError = err instanceof Error ? err.message : String(err);
    log.warn(`enterprise tree registry store read failed: ${storeError}`);
  }
  const sorted = [...entries.values()].toSorted((a, b) => (a.tree.id < b.tree.id ? -1 : 1));
  return {
    entries: sorted,
    importErrors,
    ...(storeError !== undefined ? { storeError } : {}),
  };
}

/** Full registry snapshot including the imported-tree load state. */
export function getWorkflowTreeRegistrySnapshot(
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeRegistrySnapshot {
  if (options.env !== undefined || options.stateDatabasePath !== undefined) {
    // Custom state-DB options bypass the process snapshot so optioned callers
    // (tests, programmatic flows) never read another store's cached trees.
    return loadRegistry(options);
  }
  const state = holder();
  state.snapshot ??= loadRegistry(options);
  return state.snapshot;
}

/** Registry entries (builtin + imported), sorted by tree id. */
export function listWorkflowTreeRegistryEntries(
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeRegistryEntry[] {
  return getWorkflowTreeRegistrySnapshot(options).entries;
}

/** Runtime tree definitions for subtree selection, deterministic order. */
export function listWorkflowTreesForRuntime(
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeDefinition[] {
  return listWorkflowTreeRegistryEntries(options).map((entry) => entry.tree);
}

/** Look up one registry entry by tree id. */
export function getWorkflowTreeRegistryEntry(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeRegistryEntry | undefined {
  return listWorkflowTreeRegistryEntries(options).find((entry) => entry.tree.id === treeId);
}

/**
 * Drop the cached snapshot so the next read reloads from the store. Called
 * after same-process imports/removals; cross-process consumers (a running
 * gateway) pick changes up on restart, matching plugin metadata semantics.
 */
export function invalidateWorkflowTreeRegistry(): void {
  holder().snapshot = undefined;
}
