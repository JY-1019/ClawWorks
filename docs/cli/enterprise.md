---
summary: "CLI reference for `openclaw enterprise` (workflow trees and run traces)"
read_when:
  - You want to import, export, or validate ClawWorks workflow trees
  - You want to share a workflow and its knowledge as one portable bundle
  - You are inspecting enterprise run traces and governance decisions
title: "Enterprise"
---

# `openclaw enterprise`

Manage ClawWorks enterprise workflow trees and inspect enterprise run traces.

In enterprise mode (on by default) every agent run binds to a workflow tree
whose nodes carry ontology bindings and governance policies. Trees are
versioned, importable, and exportable so organizations can share them.

## Workflow trees

```bash
openclaw enterprise trees list [--json]
openclaw enterprise trees validate <file>
openclaw enterprise trees import <file>
openclaw enterprise trees export <treeId> [--out <file>] [--format yaml|json]
openclaw enterprise trees remove <treeId>
```

- Definition files use YAML or JSON with the versioned
  `schema: clawworks.workflow-tree` envelope. `validate` prints path-scoped
  issues without importing.
- Imported trees override built-in trees with the same id; removing the
  import restores the built-in definition.
- A running gateway loads tree definitions at startup; restart it after
  imports or removals.

## Bundles

A bundle is a self-contained exchange artifact: one workflow tree plus
everything it references, so a recipient can import it and run identically
with no extra setup.

```bash
openclaw enterprise bundle export <treeId> [--out <file>] [--format yaml|json]
openclaw enterprise bundle import <file>
```

- A bundle inlines the knowledge foundations the tree references and lists
  the tool names its nodes allow or deny, on top of the tree definition
  itself. `import` persists the tree and the inlined foundations, then a
  gateway restart re-registers them.
- Only foundations this deployment owns in process (the in-memory reference
  adapter) can be inlined. Server-backed corpora expose no full-text read, so
  `export` reports them as skipped and the recipient must configure those
  foundations separately.
- The required-tools list is informational: a bundle carries workflow scope
  and knowledge, never tool implementations, so confirm the target deployment
  provides the listed tools.

### Known limitations

- Bundled knowledge is workflow-scoped: a run may only retrieve foundations its
  own tree imported, so a bundle's knowledge never leaks into another workflow.
- Bundled knowledge is not versioned with tree-definition revision history.
  Restoring an older tree revision restores the definition, not that revision's
  bundled knowledge; re-import the bundle to restore its knowledge.
- Re-importing or removing a tree reconciles the live knowledge registry
  immediately, so an already-running agent's `knowledge_search` reflects the new
  state on its next call. Apply tree/bundle changes between runs, or restart the
  gateway, when in-flight consistency matters.

## Run traces

```bash
openclaw enterprise runs list [--limit <n>] [--json]
openclaw enterprise runs show <runId> [--json]
```

`runs show` prints the latest execution for a runId: the selected tree,
plan nodes, and the trace event log (run lifecycle plus governance
decisions per workflow node).

Enterprise mode is configured through the `enterprise` config section
(`mode: enforce | observe | off`, plus `governance.policies`). See
[ClawWorks Enterprise](/concepts/clawworks-enterprise) for the full model:
workflow trees, ontology bindings, governance policies, and knowledge
foundations.
