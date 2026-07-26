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
- The required-skills list is informational the same way: a bundle records the
  flat SKILL.md skill names its nodes declare (`ontology.skills`), never skill
  content, so confirm the target has those skills installed.

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

## Governance policies

Compile a plain-language governance intent into a structured policy for review:

```bash
openclaw enterprise policy compile "<intent>" [--model <provider/model>] [--json]
```

- The command asks a model to translate the intent (for example
  `"require approval before the issue-refund action"`) into one governance policy.
  By default it prints a readable summary; pass `--json` to emit the raw policy on
  stdout for `jq`/config tooling. It is an authoring aid only: nothing is changed.
  Review the suggestion, then add it under `enterprise.governance.policies` in your
  config.
- `--model` must be a full `provider/model` ref; a partial ref like `openai/` is
  rejected rather than silently falling back to the agent's default model.
- Policies scope by tree, node, tool, action, and knowledge-foundation globs —
  never by value predicates or record attributes. An intent that implies a numeric
  threshold ("refunds over $200"), an amount, or an attribute ("VIP customers only")
  cannot be expressed exactly; the draft captures the closest representable id scope.
  The command's review reminder always states this limitation, so confirm the
  selectors capture your intent before adopting the policy.
- `*` is the only wildcard. Every selector (tree, node, tool, action, and knowledge)
  is matched with the same rules as sandbox tool policies: names are case-insensitive,
  tool aliases apply (`bash` matches `exec`), and a `group:<name>` id expands to its
  members (so a `write` selector also governs `apply_patch`). A selector can therefore
  govern a broader or different id than its literal text suggests — review the reminder
  before adopting the policy.
- A policy with no selectors is a run-level rule that applies to every enterprise run,
  so an all-selectors-omitted `deny` blocks all runs. The review summary marks this
  explicitly as `scope: every enterprise run`.
- Runtime enforcement stays deterministic and admin-owned. A model never gets a
  vote at run time; it only helps you draft the structured rule.
- The draft is validated against the governance policy schema, so a malformed
  suggestion fails with a path instead of being printed.

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
