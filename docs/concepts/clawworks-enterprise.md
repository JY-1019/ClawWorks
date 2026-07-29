---
summary: "ClawWorks enterprise mode: ontology-driven workflow trees, governance policies, knowledge foundations, and run tracing"
read_when:
  - You want to constrain agent runs with workflow trees and governance policies
  - You are configuring enterprise mode, ontology bindings, or knowledge foundations
  - You are inspecting governed run traces from the CLI, gateway, or Control UI
title: "ClawWorks Enterprise"
---

# ClawWorks Enterprise

ClawWorks adds an ontology-driven execution layer on top of the standard agent
loop. When enterprise mode is active, every agent run is bound to a **workflow
tree** whose nodes carry **ontology bindings** (allowed tools, knowledge
foundations, context hints) and are gated by **governance policies**. Run
lifecycle and governance decisions (denials, approvals, and audited steps) are
written to a SQLite trace you can inspect from the CLI, the gateway, or the
Control UI. Default-allow tool calls are not traced unless a node opts in with
`audit: true`, so stock runs stay quiet.

Enterprise mode is on by default and stays backward compatible: the default
built-in trees (`clawworks.assist`, `clawworks.system`) are guidance-free, so a
stock install behaves like ordinary OpenClaw until you import trees or declare
policies. One shipped built-in, `clawworks.support` ("Customer support
(example)"), is a guidance-bearing demo you can inspect in the Control UI; it
carries per-node ontology and tool scope, but only imported work-maps ever
govern a request, so normal requests are never affected. Adopt it by exporting
and importing it back:

```bash
openclaw enterprise trees export clawworks.support --out support.yaml
openclaw enterprise trees import support.yaml
```

## Modes

Set the mode in the `enterprise` config section:

```jsonc
{
  "enterprise": {
    "mode": "enforce", // enforce | observe | off
  },
}
```

- **enforce** (default): governance denials block tool calls and knowledge
  retrieval, and unreadable trees fail closed.
- **observe**: decisions are recorded but never block; unreadable trees fall
  back to built-ins with a warning.
- **off**: no mediation. Runs behave like ordinary OpenClaw.

`openclaw doctor` migrates older config shapes; the runtime only reads the
current shape.

## Workflow trees

A workflow tree is a versioned, importable definition. Each node is a step; leaf
nodes are the executable steps a run advances through.

```yaml
schema: clawworks.workflow-tree
schemaVersion: 1
id: acme.support
version: 1.0.0
name: Customer support
description: Triage and resolve customer requests.
match:
  triggers: [user]
  priority: 10
root:
  id: support
  title: Support
  ontology:
    contextHints:
      - Be concise and cite the order id in every reply.
  children:
    - id: support.triage
      title: Triage the request
      ontology:
        allowedTools: [memory_search, knowledge_search]
        knowledgeFoundations: [acme.support-kb]
        audit: true
    - id: support.resolve
      title: Resolve or escalate
      ontology:
        allowedTools: [memory_search, message]
        deniedTools: [exec, process]
        skills: [refund-playbook]
        expectedOutput: A resolution summary or an escalation note.
```

A node's `ontology.skills` names the [skills](/tools/skills) whose know-how the
step depends on, using flat SKILL.md names (lowercase letters, digits, hyphens).
The step digest renders them under that step, so the model working a step is
told which know-how that step depends on and prefers it over improvising.

It stays in the advisory lane. Naming a skill points the model at know-how it
already has; it never installs one and never grants a tool the step's
`allowedTools` withholds, so enforcement still wins on conflict. Skills load
through the normal skill system, and availability stays agent-wide — the digest
names what a step depends on, it does not change which skills exist. A declared
name no install provides is an authoring mistake, reported on the Skills screen
rather than at run time.

The instructions come with the run. At run start the declared skills' `SKILL.md`
bodies are read once and appended to the step digest under "Skill instructions
for the steps above", so the model already has the know-how when it reaches the
step: a step whose `allowedTools` withholds `read` gets the instructions all the
same, on embedded and CLI-backed runs alike. (ACP is the exception; see below.)

What is inlined is the `SKILL.md` itself, without a path — mediation runs before
a sandboxed run materializes its own copies, so a location rendered here would be
one that run cannot use. A skill that delegates detail to support files next to
it (`references/…`, `scripts/…`) therefore needs both `read` in the step's scope
and the skill's own entry in the normal skills catalog, which is where its
location comes from. For a governed step, keep the detail it depends on in the
`SKILL.md`.

Candidates come from the skills the run already resolved for its agent, which is
the containment boundary — a step can surface a skill the agent has, never add
one the agent's skill filter excluded, and instructions are text that still
cannot call a tool the step withholds. A declared name the agent does not have is
named in the step's Skills line but carries no body; it is an authoring gap,
reported on the Skills screen. Bodies are frontmatter-stripped, ordered by name,
and size-bounded so a long skill cannot crowd out the workflow guidance.

Three limits remain. Two apply to the whole step digest rather than to skills:
ACP runs never see it, because they own their prompt channel, so the digest is
discarded there and `ontology.skills` stays operator-facing alongside the same
limitation on `contextHints` and `expectedOutput`; and a CLI-backed session
running with `systemPromptWhen: "first"` sends its system prompt once, so a
resumed session keeps the digest it started with and a later turn that binds a
different work-map does not resend one (start a new session to rebind).

The third is specific to inlining: bodies are only carried when the run reached
mediation with resolved skills to read from. A recurring cron turn that reuses a
persisted session snapshot has none, because persistence keeps the catalog but
drops the runtime-only resolved entries, and some entry points (voice consults,
for instance) resolve their skills after mediation rather than before. Those runs
still name the step's skills and still get every other binding; they just do not
carry the bodies. Resolving them there would mean rebuilding the skill set on the
run path, which is the cost that snapshot reuse exists to avoid.

Manage trees with the CLI (see [`openclaw enterprise`](/cli/enterprise)):

```bash
openclaw enterprise trees validate acme-support.yaml
openclaw enterprise trees import acme-support.yaml
openclaw enterprise trees list --json
```

Imported trees override built-in trees with the same id; removing the import
restores the built-in. A running gateway loads trees at startup, so restart it
after imports or removals.

A fuller example with a complete ontology (entities, relationships, actions,
constraints, and tool/knowledge scopes across a multi-step tree) lives in the
source repository at `examples/enterprise/incident-response.clawworks.yaml`. From
a source checkout, import it with:

```bash
pnpm openclaw enterprise trees import examples/enterprise/incident-response.clawworks.yaml
```

That example, like the other tree files, is a declaration rather than something
that runs as shipped: a tree cannot carry its own knowledge, so `knowledge_search`
retrieves nothing until you register `acme.runbooks` yourself, and its
placeholder skills (`incident-triage`, `runbook-execution`) are ids no install
provides — only `summarize` resolves, because that one ships with OpenClaw.

For an example where all three governed axes are live, import the bundle
instead. It inlines its knowledge foundation and declares only a bundled skill,
so nothing else has to be configured:

```bash
pnpm openclaw enterprise bundle import examples/enterprise/support-desk.clawworks-bundle.yaml
pnpm openclaw gateway restart
```

The restart is required: a running gateway holds its tree registry for the life
of the process, so an import made from the CLI is not visible to the Control UI
or to runs until it reloads.

Then open Enterprise and select the work-map on Worktree. The Tools and Skills
screens list the catalog for the gateway's default agent — tools resolve against
an agent's workspace and skills against its filter, so a multi-agent install has
no single catalog, and the screens name the agent they answered for. Each entry
the selected work-map binds is tagged with the steps that use it; a skill a step
declares but no install provides is listed too, marked "not installed".

### Ontology bindings

Each node carries executable metadata in its `ontology`:

- `allowedTools` / `deniedTools`: tool name globs. Empty or omitted allows all;
  deny wins over allow. Each node on the root-to-active path is an independent
  gate, so a leaf inherits every ancestor's scope.
- `knowledgeFoundations`: knowledge foundation ids the step may query. Empty or
  omitted allows every configured foundation.
- `contextHints` / `expectedOutput`: compact lines surfaced to the model in the
  step digest so it knows the rules up front.
- `guidance`: a free-form instruction line for the step, rendered in the digest.
  Advisory only: tool scope and governance policies still enforce, and if they
  conflict, enforcement wins.
- `audit`: record a trace event for every tool decision under this node, even
  default allows.

Guidance is the advisory lane: it teaches the model how to work but never widens
what it may do. Structure (tool scope, the object model) and governance policies
remain the enforced authority.

### The typed object model

Beyond the execution scope above, a node's `ontology` can declare a typed object
graph that the agent operates on directly:

- `entities`: object types. Each has `properties`, and the property marked
  `primaryKey` is the type's identity. Only a type with a primary key can own
  addressable instances.
- `relationships`: typed links between two entity types (`from` and `to`, with
  an optional `cardinality` and `inverse`).
- `actions`: typed operations. An action's `effects` name the entity it creates
  or updates and the properties it writes. Declaring an effect is the write
  authorization for that object type.
- `functions`: derived values written in a small closed, type-checked expression
  language and evaluated against one object.
- `objects` and `links`: seed instances and edges the tree ships with. A
  re-import replaces the seeds while rows a run created at runtime are preserved.

Object types are tree-scoped, so instances are stored once per tree. But each
node only sees the types, properties, relationships, actions, and functions on
its own root-to-node path, so a sibling branch's declarations are never
addressable from the current step.

## How a run is mediated

When a request starts an enterprise-mediated run:

1. **Selection** narrows the imported work-maps to the ones serving the run's
   trigger, then a model judges which of them governs the request. Built-in
   trees other than the default are shipped examples and never govern until you
   import them. The `matchedBy` recorded on the run says which path it took:

   | `matchedBy`      | What happened                                   | What governs                      |
   | ---------------- | ----------------------------------------------- | --------------------------------- |
   | `planner`        | The model chose a work-map                      | that work-map, routed             |
   | `no-match`       | The model judged that none apply                | the default tree                  |
   | `only-candidate` | No work-map is installed for this trigger       | the default tree                  |
   | `unavailable`    | No planner could be consulted at all            | the default tree                  |
   | `fallback`       | A planner answered unusably, or the call failed | the first work-map, planned whole |

   The last two look alike but must not be confused. `fallback` fails closed onto
   a work-map because a crafted request can provoke an unusable answer, and that
   must not become a way out of governance. `unavailable` means no model is
   configured or authorized for planning — a property of the install that no
   request can trigger — so the default tree governs instead; otherwise every
   request on that machine, a poem included, would run under whichever work-map
   sorts first. If work-maps stop binding, check for
   `enterprise workflow planner: model unavailable` in the gateway log: a backend
   without a direct API credential (a CLI or subscription runtime) cannot plan.

2. **Decomposition** flattens the chosen subtree into a depth-first plan. For
   embedded and CLI runs the whole subtree's guidance is injected once as a
   static step digest so the model sees every step's rules up front (this keeps
   the prompt cache stable). ACP runs own their prompt channel and do not
   receive the digest, so `contextHints` and `expectedOutput` are not
   model-visible there.
3. **Step advancement** moves the active node leaf by leaf as real turns
   execute, so governance always scopes the current step.
4. **The tool-call gate** evaluates each tool call against the active node's
   ontology merged down the root-to-active path, then against config governance
   policies.

Only the embedded agent runtime advances steps; CLI and ACP runs stay on the
root scope as a safe backstop.

## Operating on the ontology

When a run's active node declares a typed object model, the agent gets tools
scoped to that node:

- `search_objects`: list instances of an object type the step declares.
- `get_neighbors`: walk a declared relationship from one object to its
  neighbors.
- `compute_function`: evaluate a declared function over one object.
- `invoke_action`: perform a declared action, writing the objects and links its
  `effects` authorize.

The read tools appear whenever the run declares an ontology; `invoke_action`
appears only when the tree opts into ontology writes. Every tool is bounded to
the active node's path and to addressable types (those with a primary key), so a
step can never read, traverse into, or write an object type outside its own
contract. Writes are recorded to the run trace as `action.invoked` events.

## Governance policies

Declare policies under `enterprise.governance.policies`. A policy applies only
when all of its present selectors match.

```jsonc
{
  "enterprise": {
    "governance": {
      "policies": [
        {
          "id": "no-runtime-in-support",
          "effect": "deny",
          "trees": ["acme.support"],
          "tools": ["exec", "process", "browser"],
        },
        {
          "id": "review-escalations",
          "effect": "require_approval",
          "nodes": ["support.resolve"],
          "tools": ["message"],
          "approval": { "timeoutMs": 30000, "timeoutBehavior": "deny" },
        },
      ],
    },
  },
}
```

- **Effects and precedence**: `deny` > `require_approval` > `allow` > `audit`.
  Composition is order independent.
- **Selectors**: `trees` and `nodes` scope where a policy applies; `tools` and
  `actions` scope tool calls; `knowledge` scopes knowledge retrieval. A policy
  targets one scope family. Mixing a tool selector with a knowledge selector in
  one policy is rejected.
- **require_approval** applies to tool and action scopes only. It routes
  through the standard tool-approval flow with the policy's `approval` timeout
  and fail-closed default. Knowledge-scoped policies support `deny` and `audit`
  only, because knowledge retrieval has no interactive approval channel.

## Knowledge foundations

Knowledge foundations are retrieval sources the `knowledge_search` tool can
query, scoped by the active step's `knowledgeFoundations` allow-list and gated
by `knowledge` policies. The tool is only offered when at least one foundation
is registered.

Foundations are registered by adapter plugins. The bundled
[LightRAG plugin](/plugins/reference/lightrag) exposes one or more LightRAG API
servers:

```jsonc
{
  "plugins": {
    "entries": {
      "lightrag": {
        "enabled": true,
        "config": {
          "foundations": [
            {
              "id": "acme.support-kb",
              "serverUrl": "http://localhost:9621",
              "kind": "remote",
              "apiKey": "${LIGHTRAG_API_KEY}",
              "mode": "mix",
            },
          ],
        },
      },
    },
  },
}
```

A node references the foundation by id in `knowledgeFoundations`. One
foundation failing (for example a down server) skips that foundation rather
than failing the whole retrieval.

By default `knowledge_search` queries every foundation the step allows and
merges the results. When several are in scope, the model can pass a
`foundations` argument to target specific ids; any id outside the step's
allow-list is reported as skipped, never queried, so targeting narrows the
search but never widens authority. To help the model route, the
`knowledge_search` tool description lists the foundations this workflow
references, each with the short summary from its adapter's
`describe().description` (the operator-facing display name is never surfaced to
the model). Returned snippets carry a `foundationId` (and a `source` when the
foundation provides one), and the tool advises the model to cite the foundation,
plus the `source` when the snippet has one, whenever it uses a snippet.

The shipped `clawworks.support` example work-map references a
`clawworks.support-kb.example` foundation, and a small example corpus (refund
windows, shipping targets, escalation rules) ships registered under that id so
the retrieval path works out of the box: it appears on the Knowledge screen on a
fresh install, and `knowledge_search` returns real snippets once the example is
imported. It is registered against that one tree, so no other workflow can
retrieve it and stock runs are unaffected.

The id is example-scoped deliberately. Register a production foundation under an
id of your own (for example a LightRAG server with `"id": "acme.support-kb"`, as
above) and name that id in the step's `knowledgeFoundations`. Reusing the
example's id would mean a plugin that fails to load silently falls back to the
shipped corpus, answering retrieval with example policy instead of reporting the
foundation as unavailable.

Each foundation declares a `kind`: `remote` (default) when someone else
operates the server, or `local` when this deployment owns it. The distinction
is an explicit operator declaration, not something inferred from the URL, and it
decides whether operators may manage that foundation's documents.

Adapters may optionally implement `describe()` and `testConnection()` (see
`plugin-sdk/enterprise-knowledge-host`) to report their kind, display name, and
live reachability. Adapters that implement neither still work — they are listed
with a neutral descriptor and report their connection status as unsupported.

## Inspecting runs

Every mediated execution writes a trace: the selected tree, plan nodes, and an
event log of run lifecycle plus governance decisions.

- **CLI**: `openclaw enterprise runs list` and `openclaw enterprise runs show
<runId>` (see [`openclaw enterprise`](/cli/enterprise)).
- **Gateway**: operator clients read via `enterprise.trees.list`,
  `enterprise.trees.get`, `enterprise.trees.export`, `enterprise.runs.list`,
  `enterprise.runs.get` (keyed by execution id, since one run id can span
  retries), and `enterprise.objects.list` — all `operator.read`. Editing the
  tree registry is admin-scoped: `enterprise.trees.import` and
  `enterprise.trees.remove` require `operator.admin`, and every import records a
  revision browsable through `enterprise.trees.history.list` /
  `enterprise.trees.history.get`.
- **Control UI**: the sidebar's **Enterprise** group holds one route per surface —
  **Worktree** (`/enterprise`), **History** (`/enterprise/history`), **Tools**
  (`/enterprise/tools`), **Skills** (`/enterprise/skills`), and **Knowledge**
  (`/knowledge`) — so each is deep linkable.
  - _Worktree_ renders the tree's node hierarchy and an ontology graph. Clicking a
    node opens that node's own scope: the ontology it can address plus the live
    object instances of each addressable type (served by `enterprise.objects.list`,
    which fails closed on a tree whose definition did not load and only returns
    instances of types the current definition still addresses).
  - _History_ lists recent runs and shows a per-execution inspector with the plan
    steps, their ontology scope, and the governance trace.
  - _Tools_ and _Skills_ are catalogs: every tool the gateway exposes (grouped as
    the runtime groups them, `tools.catalog`) and every installed skill with its
    eligibility (`skills.status`). They browse what exists; neither is scoped to a
    step. Both are agent-scoped server-side — plugin tools resolve against an
    agent's workspace and skills against its filter — so each screen names the
    agent it answered for rather than implying one deployment-wide list.
  - Binding happens on the step: selecting a node on Worktree opens **Step
    bindings**, which shows that step's `ontology.allowedTools`,
    `ontology.skills`, and `ontology.knowledgeFoundations`, marks declared skills
    that agent has no install for and foundation ids this work-map cannot
    retrieve (`enterprise.knowledge.foundations.list` reports `ownerTreeIds` for
    bundle-owned foundations, which retrieval resolves only for their owning
    tree). With `operator.admin`, each of the three has an Add button that opens a
    search dialog over the matching catalog: tick one or more entries, confirm,
    and they are written straight away — tool scopes additionally accept a typed
    glob or `group:` selector, since no catalog can enumerate those. Adding a
    child step is a separate control in its own block, because it changes the
    work-map's shape rather than what the step may call; that one still opens the
    editor for review. Every change lands through the same
    `enterprise.trees.import` whole-tree replace. Adding the first tool (or the first foundation) on a step
    turns that list into an allowlist, and every step from the root is an
    independent gate, so the UI warns when an entry narrows scope or when an
    ancestor's allowlist would still deny it.

## Related

- [`openclaw enterprise` CLI](/cli/enterprise)
- [LightRAG knowledge plugin](/plugins/reference/lightrag)
- [Agent loop](/concepts/agent-loop)
