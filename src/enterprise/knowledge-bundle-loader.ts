/**
 * Registers the knowledge foundations a prior `bundle import` persisted to
 * SQLite into the process-local retrieval registry, so `knowledge_search` works
 * after a gateway restart. The store is the canonical source; this only
 * re-hydrates the in-memory registry.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  listBundledKnowledgeFoundations,
  type EnterpriseKnowledgeStoreOptions,
} from "./enterprise-knowledge-store.sqlite.js";
import {
  clearBundleKnowledgeFoundations,
  InMemoryKnowledgeFoundation,
  registerBundleKnowledgeFoundation,
} from "./knowledge.js";

const log = createSubsystemLogger("enterprise");

// Symbol-keyed so duplicated dist chunks share the flag. It gates the hot
// per-run load path; the gateway's per-lifecycle boundary calls reload() which
// re-reads SQLite regardless, because globalThis (and this flag) survive an
// in-process gateway restart.
const LOADED_KEY = Symbol.for("openclaw.enterpriseBundleFoundationsLoaded");

function loadedHolder(): { [LOADED_KEY]?: boolean } {
  return globalThis as { [LOADED_KEY]?: boolean };
}

/**
 * Load persisted bundle foundations once per process. Called on the hot runtime
 * plugin-load path (per run/session), so the flag keeps it from re-reading SQLite
 * every call. The gateway restart boundary and tree removal use reload() instead.
 */
export function ensureBundleFoundationsLoadedOnce(
  options: EnterpriseKnowledgeStoreOptions = {},
): void {
  const holder = loadedHolder();
  if (holder[LOADED_KEY]) {
    return;
  }
  holder[LOADED_KEY] = true;
  loadPersistedBundleFoundations(options);
}

export function loadPersistedBundleFoundations(
  options: EnterpriseKnowledgeStoreOptions = {},
): void {
  let result;
  try {
    result = listBundledKnowledgeFoundations(options);
  } catch (err) {
    // A store read fault must not block runtime startup: the persisted
    // foundations are simply absent until repaired (knowledge_search returns
    // nothing for them), rather than failing the whole plugin-load path.
    log.warn(
      `failed to load persisted bundle knowledge foundations: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  for (const record of result.records) {
    // Register scoped to the owning tree so bundle knowledge stays workflow-local.
    // Re-imports are idempotent (content keyed by id, ownership accumulates). The
    // stored label is kept, but the kind is forced to "remote": an inlined snapshot
    // is read-only, not a store this deployment administers, so the inspector must
    // not offer document management (Files section) that has no backing here.
    registerBundleKnowledgeFoundation(
      record.treeId,
      record.foundation.id,
      new InMemoryKnowledgeFoundation(record.foundation.snippets, {
        ...record.foundation.descriptor,
        kind: "remote",
      }),
    );
  }
  for (const rowError of result.rowErrors) {
    log.warn(
      `skipped corrupt persisted bundle knowledge foundation "${rowError.foundationId}": ${rowError.message}`,
    );
  }
}

/**
 * Rebuild the bundle registry from the current SQLite rows. Used at the gateway
 * lifecycle restart boundary (globalThis survives an in-process restart, so the
 * once-flag alone would keep serving pre-import content) and after a tree removal
 * (which deletes that tree's rows). The store is canonical, so clearing and
 * re-registering evicts foundations no remaining tree carries while keeping shared
 * ones. Marks the once-flag satisfied so a later ensure-once call does not re-read.
 */
export function reloadPersistedBundleFoundations(
  options: EnterpriseKnowledgeStoreOptions = {},
): void {
  loadedHolder()[LOADED_KEY] = true;
  clearBundleKnowledgeFoundations();
  loadPersistedBundleFoundations(options);
}

/**
 * Test-only: clear the bundle registry AND the once-guard. Under the repo's shared
 * worker mode (`--isolate=false`) the guard lives on globalThis, so a test that
 * imports/reloads leaves it set; without this reset a later test would skip
 * hydration and observe an empty registry. Use in teardown.
 */
export function resetPersistedBundleFoundationsForTest(): void {
  loadedHolder()[LOADED_KEY] = false;
  clearBundleKnowledgeFoundations();
}
