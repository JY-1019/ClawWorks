---
title: "Enterprise Worktree Remaining Features"
summary: "Gap report for governed work-map routing, context attribution, portability, GUI authoring, plugin compatibility, and AIP-style ontology."
read_when:
  - Planning the remaining ClawWorks Enterprise work
  - Reviewing work-map routing, governance, resume, or portability scope
  - Comparing the current ontology surface with Palantir AIP
---

# Enterprise Worktree Remaining Features

This report audits the requested Enterprise worktree features against `main` at
`8ed9ce183933` on 2026-09-06, plus the Enterprise Control UI authoring changes in
this update. It describes current source behavior, not whether a public release
already contains it.

The first pass was written against `b21e018424a` on 2026-08-15. Thirteen commits
landed through `1c26aa5c1c9`; [what they moved](#what-changed-since-the-first-pass)
is recorded below. This focused refresh re-verifies the GUI-authoring row; the
rest retain their previous evidence.

Here, **worktree** means the product's workflow tree or work-map, not a Git
worktree.

## Outcome

The core architecture already exists: an LLM selects a work-map route before the
main agent loop, one run walks multiple steps with `complete_step`, each step has
governed capabilities, SQLite records the run trace, and the Control UI shows the
active step. The remaining work is mainly correctness at the boundaries,
portable packaging, and operator UX.

| Requested feature                                   | Status                                     | Current behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Remaining work                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route before the tool loop                          | Partial                                    | A model selects an imported work-map and route before the main agent loop. Invalid planner output fails closed to a whole work-map. Route planning now keeps only an operator-pinned auth profile, and an install-level refusal (no credit, revoked credentials) reports unavailable instead of failing closed onto an arbitrary work-map. The routing description reaches the planner whole rather than truncated at the node-line budget.                                                                       | A planner is still not guaranteed for ACP, provider-only, or unauthenticated planner paths; these bind the default tree instead, with no readiness surface before the run.                                                                                                                                                                                                                               |
| One tool-calling loop for all route nodes           | Implemented with one runtime gap           | `complete_step` advances a model-driven cursor without starting another agent run. The run, session, transcript, and tool loop stay the same.                                                                                                                                                                                                                                                                                                                                                                     | ACP owns its tool channel and cannot call `complete_step`, so it remains on the opening step.                                                                                                                                                                                                                                                                                                            |
| Shared context with node attribution                | Partial                                    | Every step uses the same session history. Trace events record node entry/completion, step summaries, and caller-visible `complete_step` anchors.                                                                                                                                                                                                                                                                                                                                                                  | Long-term memory and transcript content do not carry durable node provenance. The opening step and loopback-backed transitions have run-level, not exact message-level, attribution.                                                                                                                                                                                                                     |
| Per-node Tool, Skill, MCP, and Knowledge governance | Partial                                    | `capabilityGrants: explicit` scopes all four families. The UI can attach/detach grants, add hard tool denials, and edit description, instructions, context hints, expected output, and auditing for each step. A governed run now registers its tools under the names its rules use, and the gate fails closed when the Codex relay cannot answer. Authoring warnings identify capabilities that no run under a step can reach; incomplete action effects can be saved while the inspector marks them uncallable. | An unassigned tool asks for one-off approval instead of always denying. Only `message`, `read`, and `memory_search` form the core floor. ACP is outside the boundary. Skill credentials are stripped per subprocess for CLI-backed runs but the in-process environment is still shared. Two structural limits now have no seam at all — see [Limits with no current seam](#limits-with-no-current-seam). |
| OpenClaw plugin compatibility                       | Partial                                    | Plugin tools participate in the normal tool catalog and gate. Knowledge adapters have a plugin SDK facade; LightRAG uses it.                                                                                                                                                                                                                                                                                                                                                                                      | Plugin-contributed MCP servers cannot be attached through the Enterprise MCP binding model, and there is no complete published enterprise-capability contract for plugins.                                                                                                                                                                                                                               |
| Show current node, stop, and continue               | Implemented with replay semantics          | Chat receives live step transitions and exposes the normal active-run stop control. A resumable terminal route offers **Continue** beside the composer; History provides the same action and both surfaces explain refusals.                                                                                                                                                                                                                                                                                      | Continue remains an admin action. It arms the next matching request, requires at least one completed step, and restarts the unfinished step; it does not restore an in-process tool call.                                                                                                                                                                                                                |
| Import/export the whole worktree                    | Partial                                    | YAML/JSON v1 bundles carry one tree, owned snapshot-capable knowledge, dependency names, and relevant governance policy/mode metadata. Admin-scoped Gateway and Control UI flows export them and require preview-before-apply for import. The preview shows the full dependency manifest plus missing, unverified, and governance warnings; an opaque review token and a transaction-time tree-plus-knowledge check reject stale applies. Exports never copy MCP credentials or configuration.                    | External knowledge content, tool/skill/plugin implementations, MCP configuration, runtime ontology objects, traces, and revision history do not travel as one artifact. The preview reports requirements and policy gaps but does not yet calculate a complete before/after effective-capability diff.                                                                                                   |
| Easy GUI assignment and prompting                   | Partial; normal definitions are visual     | The UI now covers tree routing settings, step creation/title/reparent/order/subtree removal, behavior fields, capability catalogs and binding pickers, the complete static ontology definition, and bundle preview/import/export. Every visual edit uses a version-guarded whole-tree import. YAML/JSON remains an expert escape hatch rather than a requirement for an ordinary definition.                                                                                                                      | Resource assignments still appear as inspector rows rather than edges on the canvas. Branch-wide bulk assignment, an authoritative enforce/observe effective-scope preview, and runtime object seeding are absent.                                                                                                                                                                                       |
| Palantir AIP-style ontology                         | Foundation implemented, parity not reached | Typed entities, properties, relationships, actions, functions, constraints, runtime objects, links, SQLite persistence, and scoped ontology tools exist. The GUI edits every static schema field, including descriptions, required fields, inverse links, action tool coverage and preconditions, effect metadata and link parameters, and constraints.                                                                                                                                                           | A work-map still declares no instances: every row is one a run created, so a type its steps update needs a step that creates it. Seed data, data-source mapping, dynamic object/property security, enforceable preconditions, richer action logic, object-set queries, aggregations, and application-grade SDKs are absent.                                                                              |

## What changed since the first pass

Thirteen commits landed between `b21e018424a` and `1c26aa5c1c9`, plus the example
consolidation in this change. Grouped by what they moved:

| Change                                                                                                                                             | Effect on this report                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9e852bee881` route planning keeps only an operator-pinned auth profile                                                                            | Removes the concrete cause behind "planner unavailability silently weakens governance": a failover profile the turn never spends no longer fails every planning call. An install-level refusal now reports unavailable rather than dragging the request into the highest-priority work-map planned whole. The structural gap stays.                                                                         |
| `00f53700196` routing description reaches the planner whole                                                                                        | A work-map's description is the routing signal since keywords retired, and the node-line budget was cutting the domain cue authors write last. Requests about a governed domain no longer escape into the permissive default tree on phrasing alone.                                                                                                                                                        |
| `cca27c70cc2` gate fails closed when the Codex relay cannot answer, `67bcd7aa108` a governed run registers its tools under the names its rules use | Closes the two ways a native harness could run a call the work-map never judged. The Codex boundary is now enforced rather than assumed.                                                                                                                                                                                                                                                                    |
| `e65c4833307` + `2a8781207e8` capability-reachability warnings                                                                                     | New surface the first pass did not have: `collectWorkflowTreeWarnings` reports when a step advertises an action, a write, or a knowledge foundation no run under it could reach. Wired into `trees validate`, `trees import`, and `bundle import`.                                                                                                                                                          |
| `4250e8c2dcb` store-versus-corpus precedence in the digest                                                                                         | A run holding both retrieval families is told once that a fact about a named record comes from the object store, not a passage that mentions one.                                                                                                                                                                                                                                                           |
| `ed947c3f76d`, `cfd5cbcfd25`, `08aac650eb8`, `9db268a5415` shipped-example repairs                                                                 | Thirty-one of thirty-two declared actions across the shipped examples were unreachable. Now superseded: see below.                                                                                                                                                                                                                                                                                          |
| `1c26aa5c1c9` work-map authoring documented                                                                                                        | Hand authoring in YAML/JSON has a reference. It does not close the GUI row.                                                                                                                                                                                                                                                                                                                                 |
| This change: six examples consolidated into one                                                                                                    | `examples/enterprise/` now ships a single bundle — 46 nodes, 30 steps, depth 5, four domains, `capabilityGrants: explicit`, per-domain ontology with seeds, six inlined corpora, four MCP servers, nine ontology writes. `scripts/enterprise-golden.ts` asserts against that shipped file rather than a private fixture, which is what let earlier examples ship broken while the golden lane stayed green. |

## Priority 0: correctness and security boundaries

### Limits with no current seam

Native launch exposure remains a separate constraint from per-step execution.

**Resolved by sequential steps (2026-10-13):** the root and intermediate nodes
execute as predecessors. Tool scope and ontology write opt-in are local to the
active step, so a parent neither grants writes to its child nor narrows that
child's tool list. Common restrictions use tree-scoped governance policies.

**A hookless runtime's MCP ceiling is far tighter than the per-call gate.** A native server is handed to the subprocess once, before it
connects. A hookless backend cannot judge its calls afterwards, so `ceilingAdmitsMcpServer`
fails closed twice: a server is admitted only when EVERY selected step in the
plan grants it whole, and a server carrying ANY per-operation `deniedTools` entry
is never handed over at all (denials are collected from the selected route, and a native harness
renames tools by rules OpenClaw cannot invert). In practice a realistic multi-step
route through a governed work-map reaches no MCP server on those backends, and one
`server__destructive_op` denial costs that server everywhere. Per-step MCP
isolation is therefore an embedded-runtime property; on native harnesses it is
route-level. Closing this needs a name mapping the harness can be held to, not a
policy change.

### Make explicit grants truly assigned-only

The requested rule says a node can use only assigned enterprise capabilities.
Current explicit grants enforce that for skills, MCP servers, and knowledge
foundations, but a missing tool grant opens an **Allow once / Deny** approval.
That is a deliberate usability policy, but it is not assigned-only.

Target behavior:

- In strict explicit mode, an unassigned non-floor tool is denied without an
  approval escape.
- Keep one documented built-in floor. The current floor is `message`, `read`,
  and `memory_search`; do not describe every stock OpenClaw tool as implicitly
  available.
- `deniedTools` and governance `deny` continue to override the floor.
- Move skill credentials from process-wide mutation to per-run or per-subprocess
  injection before treating skill assignment as a security boundary.
- Reject or clearly mark ACP-backed runs when node governance cannot reach their
  tool channel.

Acceptance proof: a node with one assigned plugin tool cannot call another
plugin or core side-effect tool, even with an approval-capable chat attached;
two concurrent runs cannot read each other's skill credentials.

### Persist node provenance for context and memory

Sharing one session already gives every route step the previous conversation
and earlier step output. The missing part is durable provenance: the trace can
usually infer a span around `complete_step`, but the memory stores themselves do
not answer which node produced a fact.

Add an Enterprise-owned SQLite attribution projection instead of modifying the
core transcript format. Each attributed span or promoted memory should carry at
least:

```json
{
  "executionId": "...",
  "treeId": "acme.support",
  "nodeId": "support.resolve",
  "sessionId": "...",
  "startMessageId": "...",
  "endMessageId": "...",
  "kind": "conversation | tool | summary | durable-memory"
}
```

Use `nodeId: null` only for genuinely run-wide context. Compaction, transcript
rotation, memory flush, and resume must preserve or intentionally roll up this
provenance. The History UI should link a step to its exact transcript span.

Acceptance proof: after compaction and one interrupted/resumed execution, an
operator can query every context or memory item used by a node and identify its
origin without timestamp guessing.

### Guarantee route selection when a work-map can govern

The current planner correctly runs before the main tool loop, but planner
unavailability is treated differently from planner failure: it binds the
guidance-free default tree. That keeps unrelated requests usable, but it means an
installed work-map can silently stop governing when no routable model credential
exists.

`9e852bee881` removed the loudest cause — route planning inheriting a failover
auth profile the turn never spends — and reclassified install-level refusals as
unavailable rather than fail-closed, so an outage no longer drags unrelated
requests into an arbitrary work-map.

`enterprise.routePlanner.model` now removes the other one an operator could not
work around: the router made its direct completion call with whatever credential
the run had, so a CLI-backed run — whose backend authenticates itself and holds no
API credential — could not be planned at all. Naming a router model gives routing
its own model and account, independent of the turn.

The structural gap is unchanged: unavailability is still silent, and nothing
surfaces planner readiness before a run starts.

**Known limit on the router's catalog.** The router resolves through provider
discovery, which finds its model once that provider has usable auth for the agent
in question — the same step that registers the provider's catalog. The gateway also
warms the router's provider at startup. Neither covers every path: startup warming
is best-effort and writes the DEFAULT agent's catalog, and a standalone CLI run on a
non-default agent performs no warming at all, so a router that is the only reference
to a catalog-backed provider can report `unavailable` there until that agent has
resolved it once. Reading it out of the bundled manifests instead was considered and
rejected twice: that path is not gated on plugin activation, so it would let a
disabled provider serve routing, and it rescans plugin manifests on the request path
for every governed turn. Closing this properly means a lifecycle-owned catalog
resolver, not a flag on the planner's call.

Target behavior:

- Surface planner readiness in Enterprise before a run starts.
- When imported work-maps are eligible, either obtain a supported planner or
  block with an actionable error; do not silently weaken governance.
- Keep the existing whole-tree fail-closed fallback for malformed or failed
  planner responses.
- Reuse the existing selected model/auth path before adding another planner
  configuration surface.

Acceptance proof: every eligible request records `matchedBy: planner`,
`no-match`, or a visible blocking reason. Planner unavailability never produces
an apparently ordinary governed run.

## Priority 1: product completeness

### Stop and continue semantics

History and the conversation composer can arm the next matching request.
Completed steps are carried forward and the unfinished step runs again. The UI
shows why a terminal route cannot be resumed and warns that this is replay, not
an in-process checkpoint.

The UI now shows:

- current work-map, node, and `N of M` progress;
- Stop for the active run;
- Continue from the first unfinished node for a stopped run;
- why continuation is unavailable;
- a clear warning that the unfinished node restarts and an in-flight external
  side effect is not resumed.

Do not call this process checkpointing. It is route-progress continuation over
the same conversation.

### Extend the complete, safe work-map bundle

JSON already satisfies the requested XML-or-JSON portability requirement, so
XML adds no value unless a customer integration requires it. The current v1
bundle and its admin-scoped Gateway/Control UI flow already provide preview,
guarded apply, and YAML/JSON export. Preview retains the exact selected bytes,
shows all declared dependencies with local missing/unverified and governance
warnings, identifies owned knowledge that will be replaced or deleted without
revision history, flags inlined rows shadowed by same-id global/plugin foundations,
and refuses apply when the reviewed deployment or replaceable tree and
owned-knowledge state changed. Export carries no credentials and preserves a
selected tree's owned row even while a global/plugin registration shadows it.

The current v1 bundle contains:

- one tree definition, role prompts, ontology, and tree version identity;
- relevant governance policies and required enforcement mode;
- owned knowledge snapshots;
- required tool, skill, and MCP names;
- import warnings for unavailable or unverified dependencies and conflicting
  policy;
- no credentials, tokens, absolute local paths, or process environment values.

Bundle v2 should add versioned plugin and knowledge-adapter manifests with safe
configuration placeholders, optional runtime ontology objects and links behind
an explicit export switch, and a complete effective-capability diff before apply.

Acceptance proof: a clean target can import one JSON file, resolve the reported
external dependencies, and produce the same route, effective grants, owned
knowledge, and ontology state.

### Replace search-only assignment with a visual resource model

Search should remain a secondary navigation aid, not the assignment model. The
work-map canvas should pair with a typed resource palette for Tools, Skills, MCP,
and Knowledge and show edges from each node to its resources.

The minimum useful GUI shows:

- assigned, denied, missing, and effective local states separately;
- resource type, owner plugin, risk/capability group, and availability;
- drag/drop or explicit multi-select assignment from a browsable palette;
- local and tree-policy restrictions before save;
- bulk assignment to a branch;
- the selected node's effective resource scope;
- effective-scope preview in enforce and observe modes.

Raw YAML/JSON can remain an expert escape hatch, but creating a normal work-map
must not require it.

### Publish an enterprise plugin contract

Keep core plugin-agnostic. Add or document a narrow plugin SDK contract that lets
a plugin describe:

- tool ids and capability groups;
- attachable MCP servers;
- provided skills;
- knowledge foundation adapters;
- optional ontology actions and the grants they require.

The work-map should reference stable public ids, never plugin source paths. Add a
compatibility test plugin that proves discovery, GUI assignment, enforcement,
bundle dependency reporting, and missing-plugin import warnings.

## Priority 2: close the AIP ontology gap

The current ontology has the same basic nouns as Palantir's model, but it is a
small, local operational graph rather than an AIP-equivalent enterprise data
layer. Palantir describes its Ontology as objects/properties/links backed by
integrated data, with actions/functions and dynamic security, while AIP adds
builder, evaluation, governance, and application surfaces on top.

Build the next increments in this order:

1. **Extend visual authoring beyond the static definition:** seed objects and
   runtime links need a data mutation/import contract; add a visual version diff
   once the Gateway can project two revisions together.
2. **Back object types with data:** connector/mapping contracts, stable object
   identity, refresh status, lineage, and writeback ownership.
3. **Add dynamic security:** object-, property-, and action-level authorization;
   current governance selectors match ids/globs and cannot express value rules
   such as “refunds over 200 require approval.”
4. **Strengthen actions/functions:** enforceable preconditions, validation rules,
   external side effects, idempotency, and auditable transaction outcomes. The
   current natural-language preconditions are advisory.
5. **Add query composition:** object sets, filters, graph traversal, aggregation,
   and stable APIs/SDKs for applications and plugins.

Reference behavior:

- [Palantir Ontology overview](https://www.palantir.com/docs/foundry/ontology/overview)
- [Palantir action types](https://www.palantir.com/docs/foundry/action-types/overview)
- [Palantir AIP overview](https://www.palantir.com/docs/foundry/aip)
- [Palantir AIP Analyst capabilities](https://www.palantir.com/docs/foundry/aip-analyst/capabilities)

## Existing-solution preflight

Do not add a second graph or workflow framework. The existing planner, active-run
cursor, SQLite trace, governance gate, and bundle schema already own the required
execution path.

- Reuse [Lobster](/tools/lobster) inside a node when a deterministic subflow needs
  durable approval tokens; it should not replace the LLM-selected work-map.
- Reuse the normal OpenClaw plugin, skill, MCP, and tool catalogs instead of
  creating Enterprise-specific duplicate registries.
- Reuse the current JSON/YAML schema and add one bundle version. Add XML only for
  a concrete external contract.
- Keep Palantir as a behavioral reference, not a paid runtime dependency.

## Recommended delivery order

1. Lock assigned-only semantics, planner availability behavior, and the built-in
   tool floor. (Planner availability is partly addressed — see
   `9e852bee881` — but readiness is still not surfaced.)
2. Add durable node provenance and transcript-span links.
3. Extend the existing Gateway/GUI bundle v1 with v2 manifests, optional runtime
   objects, and an effective-capability diff.
4. Replace search-only binding with the visual resource model and complete the
   ontology editor.
5. Publish the plugin contract and compatibility suite.
6. Add data-backed ontology, dynamic security, and query composition only after
   the earlier boundaries are proven.

## Evidence reviewed

| Area                               | Current source and tests                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route selection                    | `packages/enterprise-planner/src/route-planner.ts`, `src/agents/enterprise-route-planner.runtime.ts`, `packages/enterprise-planner/src/route-planner.test.ts` |
| Mediation and one-loop step cursor | `src/agents/enterprise-mediation.ts`, `src/enterprise/run-mediation.ts`, `src/agents/tools/workflow-step-tools.ts`, `src/enterprise/run-mediation.test.ts`    |
| Trace, attribution, and resume     | `src/enterprise/runtime.ts`, `src/enterprise/trace-store.sqlite.ts`, `src/enterprise/trace-store.sqlite.test.ts`                                              |
| Governance and capability binding  | `src/enterprise/active-runs.ts`, `src/enterprise/governance.ts`, `src/agents/enterprise-skill-scope.ts`                                                       |
| Import/export                      | `src/enterprise/tree-io.ts`, `src/enterprise/bundle-io.ts`, `src/enterprise/bundle-io.test.ts`                                                                |
| Control UI                         | `ui/src/ui/views/enterprise.ts`, `ui/src/ui/views/enterprise-tree-edit.ts`, `ui/src/ui/controllers/enterprise-chat.ts`                                        |
| Ontology runtime                   | `src/enterprise/schema.ts`, `src/enterprise/object-store.sqlite.ts`, `src/enterprise/ontology-actions.ts`, `src/agents/tools/ontology-tools.ts`               |
| Plugin boundary                    | `src/plugin-sdk/enterprise-knowledge-host.ts`, `extensions/lightrag/index.ts`                                                                                 |
| Authoring reachability             | `src/enterprise/tree-warnings.ts`, `src/enterprise/examples.test.ts`                                                                                          |
| Shipped example and golden lane    | `examples/enterprise/financial-operations.clawworks-bundle.yaml`, `scripts/enterprise-golden.ts`, `docs/specs/enterprise-live-grid.md`                        |
| MCP launch ceiling                 | `src/enterprise/active-runs.ts` (`resolveMcpCeiling`, `ceilingAdmitsMcpServer`), `src/agents/cli-runner/execute.ts`                                           |

Related current behavior: [ClawWorks Enterprise](/concepts/clawworks-enterprise),
[`openclaw enterprise`](/cli/enterprise), [Context](/concepts/context), and
[Session management](/concepts/session).

Refresh this report after changes to the workflow bundle schema, step trace,
Enterprise UI, or plugin SDK boundary, and re-anchor the SHA at the top when you
do — a gap report that names a stale revision directs work that is already done.
