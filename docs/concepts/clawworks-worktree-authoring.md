---
title: "Worktree Authoring"
summary: "Field-by-field reference for writing a ClawWorks worktree (work-map) definition in YAML or JSON, with validation rules, authoring warnings, and worked examples."
read_when:
  - You are writing or editing a workflow tree file by hand
  - You need the exact schema, id rules, or validation errors for a work-map
  - You are converting a work-map between YAML and JSON, or packaging one as a bundle
---

# Worktree Authoring

A **worktree** (also called a work-map, or a workflow tree in the schema) is the
file that governs a run: it declares the steps a run walks, the tools, skills,
MCP servers and knowledge each step may reach, and the typed object model the
step operates on. This page is the authoring reference for that file.

For what the runtime does with it once imported (routing, mediation, the tool
gate, traces), read [ClawWorks Enterprise](/concepts/clawworks-enterprise). For
the commands, read [`openclaw enterprise`](/cli/enterprise).

This is not a Git worktree. Nothing here relates to `git worktree`.

## How the file reaches the runtime

A worktree file is an **exchange artifact**, not a config file. Nothing reads it
from disk at run time:

1. You write `acme-expenses.yaml` (or `.json`) anywhere on disk.
2. `openclaw enterprise trees validate <file>` checks it without importing.
3. `openclaw enterprise trees import <file>` validates it and writes the
   definition into the SQLite tree store, recording a revision.
4. A running gateway holds its tree registry for the life of the process, so
   restart it (`openclaw gateway restart`) before the import governs runs or
   shows up in the Control UI.

The file on disk is now a copy. Editing it changes nothing until you import
again; exporting (`openclaw enterprise trees export <treeId>`) writes the stored
definition back out, which is the safe way to pick up edits made in the Control
UI.

## YAML or JSON

Both formats carry the **same object model**. The file extension decides how it
is parsed, and nothing else does:

| Extension       | Parsed as | Notes                                                     |
| --------------- | --------- | --------------------------------------------------------- |
| `.yaml`, `.yml` | YAML      | Comments, block scalars, anchors, flow style all allowed. |
| `.json`         | JSON      | Strict `JSON.parse`: no comments, no trailing commas.     |
| anything else   | rejected  | `Unsupported file extension; use .yaml, .yml, or .json.`  |

A parse failure is reported before any schema check, prefixed with the format it
tried (`invalid YAML: ...`, `invalid JSON: ...`).

Which to pick:

- **YAML for hand authoring.** A work-map is mostly prose (descriptions, hints,
  guidance) plus lists of ids, and comments are where authoring decisions get
  recorded. Every shipped example under `examples/enterprise/` is YAML.
- **JSON for generated or machine-edited work-maps.** No comment syntax means
  nothing is lost when a tool round-trips the file, and every JSON document is
  also valid YAML if a consumer only reads YAML.

`export` defaults to YAML. Pass `--format json`, or let it infer from the output
path:

```bash
openclaw enterprise trees export acme.expenses --out acme-expenses.json
```

That is also the reliable YAML-to-JSON converter: import the YAML, export as
JSON. The stored definition is the canonical shape, so a round trip drops
comments and normalizes key order but changes no meaning.

## The smallest valid worktree

YAML:

```yaml
schema: clawworks.workflow-tree
schemaVersion: 1
id: acme.minimal
version: 1.0.0
name: Minimal
root:
  id: minimal
  title: Minimal
```

The same file as JSON:

```json
{
  "schema": "clawworks.workflow-tree",
  "schemaVersion": 1,
  "id": "acme.minimal",
  "version": "1.0.0",
  "name": "Minimal",
  "root": { "id": "minimal", "title": "Minimal" }
}
```

This imports and is selectable, but it governs nothing: it has one node, no
scope, and no guidance. See [Make the run advance](#make-the-run-advance) for
what turns a definition into something a run actually walks.

## Envelope fields

Every object in the schema is **strict**: an unknown key is a validation error,
not something ignored. Misspell `description` and the import fails with a path to
the offending key rather than dropping it.

| Field              | Required | Type                        | Notes                                                                                    |
| ------------------ | -------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `schema`           | yes      | `"clawworks.workflow-tree"` | Exact literal.                                                                           |
| `schemaVersion`    | yes      | `1`                         | Number, not a string. `"1"` is rejected.                                                 |
| `id`               | yes      | dotted id                   | Stable identity. Re-importing the same id replaces that tree.                            |
| `version`          | yes      | non-empty string            | Free-form; `1.0.0` by convention. Shown as `id@version` everywhere.                      |
| `name`             | yes      | non-empty string            | Operator-facing, and part of the routing prompt.                                         |
| `description`      | no       | string                      | The routing signal. See [Routing](#routing-and-match).                                   |
| `match`            | no       | object                      | Which run classes may bind this tree, and ordering. See [Routing](#routing-and-match).   |
| `capabilityGrants` | no       | `"explicit"`                | Switches the whole tree to deny-by-default. See [Capability grants](#capability-grants). |
| `root`             | yes      | node                        | The tree itself.                                                                         |

### Id rules

Three different id shapes appear in a worktree, and they are not
interchangeable:

- **Enterprise ids** (`id`, node ids, entity/property/relationship/action/
  function/constraint ids, knowledge foundation ids) are dotted lowercase:
  `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$`. Segments of `[a-z0-9-]`
  separated by dots. `Support.Triage`, `support triage`, and `support_triage`
  are all rejected.
- **Skill names** (`ontology.skills`) are flat SKILL.md names: lowercase
  letters, digits, single hyphens between segments, at most 64 characters. Not
  dotted, because skills are not namespaced. A name the skills runtime would
  reject is refused here rather than becoming a declaration nothing can resolve.
- **MCP server names** (`ontology.mcpServers`) are `mcp.servers` config keys
  **verbatim**. Those keys are free-form and case-sensitive, so no pattern is
  imposed: `github` and `GitHub` are two different servers.

Tool selectors (`allowedTools`, `deniedTools`) are neither: they are globs, see
[Tool scope](#tool-scope).

Node ids are unique tree-wide. A duplicate is a hard error, because plan
attribution and per-node tracing key on it.

### Routing and match

Since keyword matching retired, a model chooses the work-map. `match` is the
part it cannot override:

```yaml
match:
  triggers: [user]
  priority: 10
```

| Field      | Type                                  | Meaning                                                                                   |
| ---------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `triggers` | array of `user`, `system`, `subagent` | Which run classes may bind this tree. Omitted means `[user]`. An empty array is rejected. |
| `priority` | integer                               | Candidate ordering, higher first, then by id. Defaults to `0`.                            |
| `keywords` | array of strings                      | Retired. Still accepted so older files load; nothing reads it.                            |

`triggers` is a hard gate: a cron or heartbeat run classes as `system` and can
never bind a `user`-only work-map, whatever its text says. `priority` matters
mostly at the edges: the candidate list is what a planner failure falls closed
onto, and the first candidate is what binds.

**The `description` is the routing signal.** It is the only thing that decides
whether a request enters this work-map at all, and it is rendered into the
planning prompt with a 600-character budget (node descriptions get 120). Two
consequences for how you write it:

- Name the **domain nouns and the data** the work-map owns, not only the tasks.
  A shop work-map whose description covered "refund an order" but not "list the
  orders" lost a request phrased as `ls` to the permissive default tree, where
  the shop's own `deniedTools` never applied.
- Put the domain cue **early**. Authors write the distinguishing clause last,
  after the summary sentence, which is exactly what a budget cuts.

Keep it inside 600 characters so nothing is truncated, and keep node
descriptions inside 120.

## Nodes

```yaml
root:
  id: expenses
  title: Expense claims
  description: Root scope for expense claim work.
  ontology: {}
  children: []
```

| Field         | Required | Type             | Notes                                                                        |
| ------------- | -------- | ---------------- | ---------------------------------------------------------------------------- |
| `id`          | yes      | dotted id        | Unique across the tree.                                                      |
| `title`       | yes      | non-empty string | Shown in the UI, the planner prompt, and the step digest.                    |
| `description` | no       | string           | Planner signal for this step, and one of the things that make a run advance. |
| `ontology`    | no       | object           | The step's bindings. See [The ontology block](#the-ontology-block).          |
| `children`    | no       | array of nodes   | Omit or leave empty to make this node a leaf.                                |

Structure rules worth knowing before you draw the tree:

- **Leaves execute.** A run is active on a leaf; interior nodes contribute
  inherited scope.
- **Order is the tree's, not the planner's.** The plan is a depth-first
  flattening of the chosen subtree. The planner picks _which_ leaves a run
  visits; the file decides the order it visits them in.
- **Scope is inherited down the root-to-active path**, and every node on that
  path is an independent gate. A leaf can narrow what an ancestor allowed; it
  can never widen it.
- **A run opens on the first step of its route, not on the root**, and advances
  only when the model calls `complete_step`.
- **A tree with fewer than 5 nodes is never route-planned** — it is cheaper to
  run whole than to ask a model which branch to take. Small trees therefore
  always plan every node.

### Make the run advance

A run only tracks steps (and only then is `complete_step` offered) when **both**
hold:

1. The plan has more than one node, and
2. at least one node carries `description`, `audit: true`, or any of these
   `ontology` fields: `allowedTools`, `deniedTools`, `skills`, `mcpServers`,
   `knowledgeFoundations`, `actions`, `constraints`, `contextHints`, `guidance`,
   `expectedOutput`, `entities`, `relationships`, `functions`, `objects`,
   `links`.

A tree of bare `id`/`title` nodes imports cleanly and then never advances: the
run stays on the step it opened on for its whole life, and every later step's
scope is out of reach. Giving each node a `description` is the cheapest way to
satisfy this, and it doubles as the planner's per-node signal.

## The ontology block

Every field is optional. The block splits into three lanes, and mixing them up
is the most common authoring mistake:

| Lane               | Fields                                                                  | Enforced?                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Enforced scope** | `allowedTools`, `deniedTools`, `mcpServers`, `knowledgeFoundations`     | Yes. The per-call gate reads these.                                                                                                                     |
| **Advisory**       | `contextHints`, `guidance`, `expectedOutput`, `skills`, `constraints`   | No. Rendered into the digest; enforcement wins on conflict.                                                                                             |
| **Object model**   | `entities`, `relationships`, `actions`, `functions`, `objects`, `links` | Partly. Shapes are enforced at import; `actions.effects` is the write authorization. All but `objects`/`links` are editable per node in the Control UI. |

Plus `audit: true`, which records a trace event for every tool decision under
the node, including default allows.

### Tool scope

```yaml
ontology:
  allowedTools: [message, search_objects, "acme-tracker__*", "group:enterprise-write"]
  deniedTools: [exec, process, browser]
```

Both are **glob selectors**, matched with the same rules as sandbox tool
policies:

- `*` is the only wildcard.
- Matching is case-insensitive.
- Tool aliases apply (`bash` matches `exec`).
- `group:<name>` expands to that group's members, so a `write` selector also
  governs `apply_patch`.
- Blank entries are rejected: the matcher normalizes whitespace away, so a blank
  string would silently widen a scoped list into match-everything.

How they compose along the root-to-active path:

1. **Deny wins, from anywhere on the path** — including from a step _below_ the
   active one when it is on the planned route. `deniedTools` is the hard wall.
2. **Allow-lists intersect.** A node with no list narrows nothing; a node with
   one narrows everything beneath it. A leaf that lists a tool its root's list
   excludes can never call that tool.
3. **An omission asks, it does not refuse.** A tool no list on the path names
   raises a one-off _Allow once / Deny_ approval rather than failing, and fails
   closed when nobody answers.

That third point is the one to design around: **if a step must never touch
something, deny it.** Leaving it out only means "ask".

Two things never reach the approval prompt, because they are decided before any
call exists: an ontology write without its opt-in, and, on a native harness, an
MCP server or hosted tool withheld at launch. See
[ClawWorks Enterprise](/concepts/clawworks-enterprise#mcp-servers) for the
launch-time ceiling.

Because allow-lists intersect, **the root's list is the ceiling for the whole
tree**. Write it as the union of what every leaf needs, then narrow per leaf.

### Skills, MCP servers, and knowledge

```yaml
ontology:
  skills: [refund-playbook]
  mcpServers: [acme-tracker]
  knowledgeFoundations: [acme.support-kb]
```

- `skills` is advisory. It names know-how the step depends on so the digest can
  point the model at it, and the declared skills' `SKILL.md` bodies are inlined
  once per run. It never installs a skill and never grants a tool the step
  withholds. A name no install provides is an authoring gap, surfaced on the
  Skills screen rather than at run time.
- `mcpServers` **denies by default once any node in the tree uses it.** Attach a
  server anywhere and every step is governed, so a step with no attachment can
  call none. A tree that never mentions the field keeps the ungoverned behavior.
  On a native harness (Claude CLI, Codex) the attachment alone is not enough to
  call the server; the root must also list the server's tool globs in every
  spelling.
- `knowledgeFoundations` scopes `knowledge_search`. Empty or omitted means every
  configured foundation — except under explicit grants, where the list _is_ the
  grant. Ids must be registered by an adapter (for example the
  [LightRAG plugin](/plugins/reference/lightrag)) or inlined by a
  [bundle](#bundles-carry-knowledge); a tree cannot carry knowledge on its own.

### Advisory text

```yaml
ontology:
  contextHints:
    - Always name the claim id you acted on.
  guidance: Prefer the policy handbook over improvising a limit.
  expectedOutput: The decision, the amount, and the claim id.
```

All three are rendered into the step digest. `contextHints` is a list of short
lines, `guidance` is one free-form instruction line, `expectedOutput` is what the
step should produce. None of them widen scope; if guidance and enforcement
disagree, enforcement wins.

Budgets worth knowing while writing: the digest renders at most **8 entries per
list** (`contextHints`, `constraints`, `entities`, `relationships`, `functions`,
`actions`, and an action's `preconditions`). Entry 9 exists in the definition and
never reaches the model.

ACP-backed runs own their prompt channel and receive no digest at all, so on
those runs this whole lane is operator-facing only.

## The typed object model

### Entities and properties

```yaml
entities:
  - id: claim
    title: Expense claim
    description: One submitted expense claim.
    properties:
      - { id: id, type: id, primaryKey: true }
      - { id: employee-id, type: id, required: true }
      - { id: amount, type: number, required: true }
      - { id: submitted-on, type: date }
```

| Property field | Type                                        | Notes                                                   |
| -------------- | ------------------------------------------- | ------------------------------------------------------- |
| `id`           | dotted id                                   | Unique within the object type.                          |
| `type`         | `string`, `number`, `boolean`, `date`, `id` | `date` is an ISO-8601 string; `id` is an opaque string. |
| `primaryKey`   | boolean                                     | At most one per type, tree-wide.                        |
| `required`     | boolean                                     | A seeded object must set it to a non-null value.        |
| `description`  | string                                      | Operator-facing.                                        |

Object types are **tree-scoped**: declaring `claim` on two nodes adds to the same
type rather than creating a second one, so declarations must agree across the
tree (same property types, one primary key). Visibility is narrower than scope —
a node only addresses the types on its own root-to-node path, so a sibling
branch's types are never reachable from the current step.

Only a type with a `primaryKey` has addressable instances. Without one it cannot
be seeded, cannot be written by an action, and cannot be looked up.

### Relationships

```yaml
relationships:
  - id: submitted
    from: employee
    to: claim
    cardinality: one-to-many
    inverse: submitted-by
    description: The employee who submitted the claim.
```

`cardinality` is one of `one-to-one`, `one-to-many`, `many-to-one`,
`many-to-many`, and it is a contract rather than a label: seeded links are
checked against it. Link types dedupe by `[from, to, id]`, so redeclaring one
with a different `cardinality` or `inverse` is an error rather than a silent
last-wins.

### Actions

```yaml
actions:
  - id: approve-claim
    title: Approve a claim
    description: Approve the claim and record who approved it.
    tools: [invoke_action]
    parameters:
      - { id: id, type: id, required: true }
      - { id: status, type: string, required: true }
    preconditions:
      - The claim is still in submitted status.
    effects:
      - { entity: claim, kind: update, description: Records the decision. }
```

- `effects` **are** the write scope: `kind` is `read`, `create`, `update`, or
  `delete`, and `entity` must be an object type declared somewhere in the tree.
  An action with no write effect can change nothing.
- `parameters` must include the target type's primary key for any write effect,
  or no call can name the object it writes and every invocation fails
  validation.
- `tools` narrows which tools this action covers for governance `actions`
  selectors. **Omit it to cover every tool.** An empty array is accepted for
  older files and covers nothing.
- `preconditions` are advisory lines rendered under the action in the digest.

### Functions

```yaml
functions:
  - id: auto-approvable-amount
    entity: claim
    returns: number
    expression: min($amount, 100)
    description: What this claim can be approved without a human.
```

A function is a derived value computed over one object of `entity`. The
expression is parsed **and type-checked at import**, against the merged tree-wide
shape of that object type and against the declared `returns` — so a typo'd
property reference fails the import with a path instead of returning null in the
middle of a run.

### Seeded objects and links

```yaml
objects:
  - entity: employee
    properties: { id: EMP-1, name: Ada Ruiz }
  - entity: claim
    properties: { id: CLM-1, employee-id: EMP-1, amount: 64, status: submitted }
links:
  - { relationship: submitted, from: EMP-1, to: CLM-1 }
```

Seeds are typed data and are validated as such. A re-import replaces the seeds
while rows a run created at runtime are preserved.

Link endpoints name **object ids**, not entity ids, and both must be objects
seeded in this tree with the endpoint types the relationship declares.

## The expression language

`functions[].expression` is a small closed language, deliberately not JavaScript:
a work-map is operator-authored data that arrives through an import, so
executing it as code would turn "import a tree" into "run arbitrary code". There
is no host access, no loops, and no way to reach a global.

**Property references take a `$` sigil**: `$amount`, `$claim.total`. Ontology ids
are hyphenated, so a bare `claimed-amount` would lex as subtraction.

Literals: numbers (`42`, `1.5`), single- or double-quoted strings, `true`,
`false`, `null`.

Operators, loosest binding first:

| Tier | Operators             | Notes                                                                                 |
| ---- | --------------------- | ------------------------------------------------------------------------------------- |
| 1    | `? :`                 | Ternary. Condition must be boolean; both arms must unify.                             |
| 2    | `\|\|`                | Boolean only. Short-circuits.                                                         |
| 3    | `&&`                  | Boolean only. Short-circuits.                                                         |
| 4    | `==`, `!=`            | The only place two types may meet; this is how you guard a null.                      |
| 5    | `<`, `<=`, `>`, `>=`  | Two numbers or two strings. Dates are ISO strings, so lexical order is chronological. |
| 6    | `+`, `-`              | `+` adds two numbers or concatenates two strings, never across.                       |
| 7    | `*`, `/`, `%`         | Numbers only. Division or modulo by zero is an evaluation error.                      |
| —    | `-x`, `!x`, `( ... )` | Unary negation, boolean not, grouping.                                                |

Functions, with exact arity:

| Call                            | Arity | Returns                  |
| ------------------------------- | ----- | ------------------------ |
| `abs`, `round`, `floor`, `ceil` | 1     | number                   |
| `lower`, `upper`                | 1     | string                   |
| `length`                        | 1     | number (of a string)     |
| `min`, `max`                    | 2     | number                   |
| `coalesce`                      | 2     | the type both arms share |

`coalesce` is the only null-aware operation and the only one whose second
argument is evaluated lazily. It is how a definition says "this property may be
absent", which is what lets every other operator stay strict: only booleans are
truthy, so a null property never quietly reads as `false`.

Typing is checked at import, not at evaluation. These all fail the import:

```yaml
expression: $amount + null          # "+" cannot operate on null
expression: abs($status)            # "abs" expects number, got string
expression: $amount >= 100          # rejected when `returns: number` is declared
expression: $totl                   # object type does not declare "totl"
```

## Validation errors

`trees validate` and `trees import` print every issue with a dot-path into the
document, so `root.children.2.ontology.actions.0.parameters` points at exactly
one place in the file. The checks that are easy to trip:

**Envelope and structure**

- `schema` or `schemaVersion` not the exact literal.
- An unknown key anywhere (every object is strict).
- `duplicate workflow node id "..."`.

**Object types**

- `duplicate property id "..."` within one type.
- `an object type may declare at most one primaryKey property`.
- The same type declaring one property as two different types across nodes.
- The same type declaring two different primary keys across nodes.

**Link types**

- `link "..." declares cardinality as both "..." and "..."` (same for `inverse`).

**Actions**

- `action "..." effect references undeclared object type "..."`.

**Functions**

- A syntax error in the expression, reported with a position.
- `function "..." computes over undeclared object type "..."`.
- `function "..." reads "$x", which object type "..." does not declare`.
- `function "..." declares returns "..." but its expression yields ...`.

**Seeded objects**

- `seeded object references undeclared object type "..."`.
- `object type "..." declares no primaryKey, so its instances have no identity to seed`.
- `object type "..." does not declare property "..."`.
- `property "..." is declared "..." but the seeded value is ...`.
- `object type "..." declares "..." required, but the seeded object does not set it`.
- `seeded object must carry a non-blank primaryKey "..."`.
- A primary key with leading or trailing whitespace: the tools trim ids, so the
  object would be stored under a name nothing can look up.
- `duplicate "<type>" object "<id>"`.

**Seeded links**

- `seeded link references undeclared link type "..."`.
- A link type declared with more than one endpoint pair, so a seed cannot say
  which one it means.
- `link "..." from "..." is not a seeded "..." object`.
- `link "..." is one-to-many, so "..." may appear on its to side only once`.

**Blank and unsafe strings**

- A blank entry in any selector or hint list. The matcher normalizes whitespace
  away, so a blank string would widen a scoped list into match-everything.
- An empty `match.triggers` array. Omit the field instead; omitted means
  `[user]`, while `[]` would make the tree unselectable.

## Authoring warnings

Some definitions parse, import, and run, and still cannot do what they say.
`validate` and `import` print these as **warnings**, never errors: an
already-imported work-map has to keep loading, and only the author can decide
whether the fix is to grant the capability or drop the declaration.

Each check asks whether **any executable leaf path through the node** admits the
capability, because declarations inherit downward while the gate judges the
root-to-active path.

| Warning                                                | Cause                                                                            | Fix                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Step declares actions but no step under it can write   | No step on any path names `invoke_action` or `group:enterprise-write` literally. | Name one of them in `allowedTools` here or beneath. A glob like `invoke_*` does **not** opt into writes. |
| Action declares no write effects                       | Every effect is `kind: read`.                                                    | Give it a `create`/`update`/`delete` effect, or describe the work in the step description instead.       |
| Action writes a type with no `primaryKey`              | The target object type has no identity.                                          | Add a `primaryKey` property to that type.                                                                |
| Action takes no parameter for the target's primary key | No call could name the object it writes.                                         | Add `{ id: <primaryKey>, type: id, required: true }` to `parameters`.                                    |
| Step attaches a knowledge foundation it cannot query   | No path under the step can reach `knowledge_search`.                             | Grant `knowledge_search` on the step or an ancestor, and check no ancestor allow-list excludes it.       |

These are worth treating as errors in practice. A declared-but-unreachable
capability is advertised to the model in the digest and then refused by the
gate, so the run spends a turn arguing with a declaration nobody could honor —
and a model denied the action that would have created a record has been observed
inventing the record's id instead.

## Capability grants

```yaml
schema: clawworks.workflow-tree
schemaVersion: 1
id: acme.expenses
capabilityGrants: explicit
```

One optional value, and deliberately not a boolean. With `explicit`, tools,
skills, MCP servers, and knowledge foundations are all **deny-by-default**: a
step reaches only what it or a step above it attaches.

Three core tools stay available whatever the grants say — `message`, `read`, and
`memory_search` — so a step granted one knowledge source can still reply and
look at things. `exec`, `write` and `edit` are deliberately not on that floor,
and `deniedTools` overrules the floor.

Omit the field for the inherited semantics: a scope narrows what an ancestor
allowed, and a branch that scopes nothing may use anything. That stays the
default because `allowedTools` predates the switch, and silently rereading an
old file as "deny everywhere else" would break imports on upgrade.

The full boundary, including what it does not cover (ACP turns, process-scoped
skill credentials, native harness MCP handling), is documented in
[ClawWorks Enterprise](/concepts/clawworks-enterprise#capability-grants).

## A complete example

A four-node work-map that validates with no warnings. Every leaf's tools are a
subset of the root's, the write opt-in is on the root and narrowed to the one
leaf that writes, and the action carries its target's primary key.

```yaml
# Import with:
#   openclaw enterprise trees import acme-expenses.yaml
#   openclaw gateway restart
schema: clawworks.workflow-tree
schemaVersion: 1
id: acme.expenses
version: 1.0.0
name: Expense claims
# The routing signal. Names the DATA this work-map owns, not only the tasks, so a
# request phrased as "list the expense files" cannot escape into the default tree.
description: >-
  Review, approve, or reject an employee EXPENSE CLAIM, and answer questions
  about expense policy: what a claim is worth, whether it clears the automatic
  limit, who submitted it, and what the handbook says about it. The claims live
  in this work-map's own object store, never in files or a shell, so a request to
  list or check claims belongs here even when it is phrased as reading a file or
  running a command. Not for payroll, invoices, or vendor contracts.
match:
  triggers: [user]
  priority: 10
capabilityGrants: explicit

root:
  id: expenses
  title: Expense claims
  description: Root scope for expense claim work.
  ontology:
    # Root denials are inherited by every step, so no leaf can widen them.
    deniedTools: [exec, process, browser]
    # Allow-lists INTERSECT down the path, so the root list is the ceiling for
    # the whole tree: it must be the union of what every leaf needs.
    allowedTools:
      - message
      - search_objects
      - get_neighbors
      - compute_function
      - knowledge_search
      # Literal, not a glob: this is the ontology write opt-in.
      - invoke_action
    contextHints:
      - Always name the claim id you acted on.
    entities:
      - id: employee
        title: Employee
        properties:
          - { id: id, type: id, primaryKey: true }
          - { id: name, type: string, required: true }
      - id: claim
        title: Expense claim
        properties:
          - { id: id, type: id, primaryKey: true }
          - { id: employee-id, type: id, required: true }
          - { id: amount, type: number, required: true }
          - { id: status, type: string, required: true }
          - { id: submitted-on, type: date }
    relationships:
      - id: submitted
        from: employee
        to: claim
        cardinality: one-to-many
        inverse: submitted-by
        description: The employee who submitted the claim.
    functions:
      - id: auto-approvable-amount
        entity: claim
        returns: number
        # Capped at the approval limit, so the value itself says how much can be
        # approved without a human.
        expression: min($amount, 100)
        description: What this claim can be approved without a human.
    objects:
      - entity: employee
        properties: { id: EMP-1, name: Ada Ruiz }
      - entity: claim
        properties:
          {
            id: CLM-1,
            employee-id: EMP-1,
            amount: 64,
            status: submitted,
            submitted-on: "2026-08-01",
          }
    links:
      - { relationship: submitted, from: EMP-1, to: CLM-1 }

  children:
    - id: expenses.check
      title: Check the claim
      description: Find the claim, read who submitted it, and work out what it is worth.
      ontology:
        allowedTools: [search_objects, get_neighbors, compute_function]
        expectedOutput: The claim id, the employee, the amount, and the auto-approvable amount.
        audit: true

    - id: expenses.policy
      title: Check the policy
      description: Answer what the expense handbook says about this kind of claim.
      ontology:
        allowedTools: [knowledge_search, message]
        # Must be a registered foundation id, or one a bundle inlines.
        knowledgeFoundations: [acme.expense-policy]
        expectedOutput: The handbook rule that applies, cited.

    - id: expenses.decide
      title: Approve or reject
      description: Approve the claim within the limit, or reject it with a reason.
      ontology:
        # Reads AND the write: the planner may cut straight to this leaf, so a
        # step has to be able to honor its own constraint. get_neighbors is
        # deliberately absent — walking the graph is the check step's job.
        allowedTools: [search_objects, compute_function, invoke_action, message]
        actions:
          - id: approve-claim
            title: Approve a claim
            tools: [invoke_action]
            parameters:
              # The target's primary key. Without it no call can name the object
              # it writes and every invocation fails validation.
              - { id: id, type: id, required: true }
              - { id: status, type: string, required: true }
            preconditions:
              - The claim is still in submitted status.
            effects:
              - { entity: claim, kind: update, description: Records the decision. }
        constraints:
          - id: claim-cap
            description: Claims above 100 need a human approver.
        expectedOutput: The claim id and the decision, or the reason none was made.
        audit: true
```

### The same tree as JSON

Identical semantics, no comments, and `schemaVersion` stays a number:

```json
{
  "schema": "clawworks.workflow-tree",
  "schemaVersion": 1,
  "id": "acme.expenses",
  "version": "1.0.0",
  "name": "Expense claims",
  "description": "Review, approve, or reject an employee EXPENSE CLAIM, and answer questions about expense policy: what a claim is worth, whether it clears the automatic limit, who submitted it, and what the handbook says about it. The claims live in this work-map's own object store, never in files or a shell, so a request to list or check claims belongs here even when it is phrased as reading a file or running a command. Not for payroll, invoices, or vendor contracts.",
  "match": { "triggers": ["user"], "priority": 10 },
  "capabilityGrants": "explicit",
  "root": {
    "id": "expenses",
    "title": "Expense claims",
    "description": "Root scope for expense claim work.",
    "ontology": {
      "deniedTools": ["exec", "process", "browser"],
      "allowedTools": [
        "message",
        "search_objects",
        "get_neighbors",
        "compute_function",
        "knowledge_search",
        "invoke_action"
      ],
      "contextHints": ["Always name the claim id you acted on."],
      "entities": [
        {
          "id": "employee",
          "title": "Employee",
          "properties": [
            { "id": "id", "type": "id", "primaryKey": true },
            { "id": "name", "type": "string", "required": true }
          ]
        },
        {
          "id": "claim",
          "title": "Expense claim",
          "properties": [
            { "id": "id", "type": "id", "primaryKey": true },
            { "id": "employee-id", "type": "id", "required": true },
            { "id": "amount", "type": "number", "required": true },
            { "id": "status", "type": "string", "required": true },
            { "id": "submitted-on", "type": "date" }
          ]
        }
      ],
      "relationships": [
        {
          "id": "submitted",
          "from": "employee",
          "to": "claim",
          "cardinality": "one-to-many",
          "inverse": "submitted-by",
          "description": "The employee who submitted the claim."
        }
      ],
      "functions": [
        {
          "id": "auto-approvable-amount",
          "entity": "claim",
          "returns": "number",
          "expression": "min($amount, 100)",
          "description": "What this claim can be approved without a human."
        }
      ],
      "objects": [
        { "entity": "employee", "properties": { "id": "EMP-1", "name": "Ada Ruiz" } },
        {
          "entity": "claim",
          "properties": {
            "id": "CLM-1",
            "employee-id": "EMP-1",
            "amount": 64,
            "status": "submitted",
            "submitted-on": "2026-08-01"
          }
        }
      ],
      "links": [{ "relationship": "submitted", "from": "EMP-1", "to": "CLM-1" }]
    },
    "children": [
      {
        "id": "expenses.check",
        "title": "Check the claim",
        "description": "Find the claim, read who submitted it, and work out what it is worth.",
        "ontology": {
          "allowedTools": ["search_objects", "get_neighbors", "compute_function"],
          "expectedOutput": "The claim id, the employee, the amount, and the auto-approvable amount.",
          "audit": true
        }
      },
      {
        "id": "expenses.policy",
        "title": "Check the policy",
        "description": "Answer what the expense handbook says about this kind of claim.",
        "ontology": {
          "allowedTools": ["knowledge_search", "message"],
          "knowledgeFoundations": ["acme.expense-policy"],
          "expectedOutput": "The handbook rule that applies, cited."
        }
      },
      {
        "id": "expenses.decide",
        "title": "Approve or reject",
        "description": "Approve the claim within the limit, or reject it with a reason.",
        "ontology": {
          "allowedTools": ["search_objects", "compute_function", "invoke_action", "message"],
          "actions": [
            {
              "id": "approve-claim",
              "title": "Approve a claim",
              "tools": ["invoke_action"],
              "parameters": [
                { "id": "id", "type": "id", "required": true },
                { "id": "status", "type": "string", "required": true }
              ],
              "preconditions": ["The claim is still in submitted status."],
              "effects": [
                { "entity": "claim", "kind": "update", "description": "Records the decision." }
              ]
            }
          ],
          "constraints": [
            { "id": "claim-cap", "description": "Claims above 100 need a human approver." }
          ],
          "expectedOutput": "The claim id and the decision, or the reason none was made.",
          "audit": true
        }
      }
    ]
  }
}
```

## Bundles carry knowledge

A tree cannot carry its own knowledge: `knowledgeFoundations` names ids that
something else must register. A **bundle** is the superset artifact that closes
that gap, and it uses the same YAML-or-JSON rules.

```yaml
schema: clawworks.workflow-bundle
schemaVersion: 1
trees:
  - schema: clawworks.workflow-tree
    schemaVersion: 1
    # ... one whole tree definition, exactly as above
knowledgeFoundations:
  - id: acme.expense-policy
    descriptor: { kind: local, displayName: Expense policy handbook }
    snippets:
      - foundationId: acme.expense-policy
        title: Automatic approval limit
        text: Claims of 100 or less are approved automatically.
requiredTools: [knowledge_search, message]
requiredSkills: []
requiredMcpServers: []
```

| Field                  | Required | Notes                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `trees`                | yes      | Exactly one tree, so import stays a single atomic transaction.                                    |
| `knowledgeFoundations` | yes      | Inlined corpora. Every entry must be referenced by the tree, and ids must be unique.              |
| `requiredTools`        | yes      | Informational: a bundle carries scope, never tool implementations.                                |
| `requiredSkills`       | yes      | Informational: skill names, never skill content.                                                  |
| `requiredMcpServers`   | no       | Informational: server names the recipient registers themselves.                                   |
| `governancePolicies`   | no       | Validated with the runtime policy schema, so a bundle cannot smuggle a shape config would reject. |
| `governanceMode`       | no       | `enforce`, `observe`, or `off`.                                                                   |

```bash
openclaw enterprise bundle export acme.expenses --out acme-expenses-bundle.yaml
openclaw enterprise bundle import acme-expenses-bundle.yaml
openclaw gateway restart
```

Only foundations this deployment owns in process can be inlined; server-backed
corpora are reported as skipped on export, and the recipient configures those
separately.

## Authoring workflow

```bash
# 1. Check the file without importing. Prints validation errors and warnings.
openclaw enterprise trees validate acme-expenses.yaml

# 2. Import. Replaces any tree with the same id and records a revision.
openclaw enterprise trees import acme-expenses.yaml

# 3. Make it visible to runs and the Control UI.
openclaw gateway restart

# 4. Confirm what is registered.
openclaw enterprise trees list

# 5. Pull edits made in the Control UI back into your file.
openclaw enterprise trees export acme.expenses --out acme-expenses.yaml

# 6. Drop the import. A built-in with the same id reappears.
openclaw enterprise trees remove acme.expenses
```

From a source checkout, prefix with `pnpm`: `pnpm openclaw enterprise trees
validate ...`.

The Control UI edits the same definition on **Enterprise -> Worktree**: the node
inspector writes step bindings through the same whole-tree import, and every
change lands as a revision, so version history can restore an earlier shape.
Hand-authored files and UI edits are interchangeable as long as you export
before editing the file again.

One shipped example lives in the source repository, at
`examples/enterprise/financial-operations.clawworks-bundle.yaml`. It is a bundle,
so it imports and runs as-is: 46 nodes across four domains — 30 of them
executable steps — a seeded object model per domain, six inlined knowledge
corpora, four MCP servers, nine ontology writes, and `capabilityGrants: explicit`
throughout. Read it for the shape of a
real work-map rather than for a minimal one — every binding in it is load-bearing,
and the comments say which failure each one exists to prevent. The only thing it
cannot ship is the four MCP servers themselves; register them under `mcp.servers`
and the attachments resolve.

## Before you import

- `schemaVersion` is the number `1`, not `"1"`.
- Every node id is unique, dotted, and lowercase.
- Every ancestor's `allowedTools` is a superset of what its leaves need, because
  allow-lists intersect down the path. Under `capabilityGrants: explicit` this
  pulls against write isolation: `invoke_action` on a node is consent for every
  step beneath it, so a root that lists it lets the whole tree write. Either put
  the union on the root and accept that, or grant nothing there and let each step
  name what it needs — which is what the shipped example does, at the cost of a
  step-less runtime (ACP) reaching only its opening step's grants.
- Anything a step must never touch is in `deniedTools`, not merely left out.
- `invoke_action` (or `group:enterprise-write`) is named literally wherever an
  action must run, and every writing action takes its target's primary key as a
  parameter.
- Each node has a `description`, so the run advances and the planner can tell
  the steps apart.
- The tree `description` names the domain's nouns and fits in 600 characters.
- Every `knowledgeFoundations` id is registered somewhere, or the work-map ships
  as a bundle.
- `validate` printed no warnings.

## Related

- [ClawWorks Enterprise](/concepts/clawworks-enterprise)
- [Enterprise CLI](/cli/enterprise)
- [Skills](/tools/skills)
- [LightRAG knowledge plugin](/plugins/reference/lightrag)
