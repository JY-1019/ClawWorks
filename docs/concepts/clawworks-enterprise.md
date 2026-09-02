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
stock install behaves like ordinary ClawWorks until you import trees or declare
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
- **off**: no mediation. Runs behave like ordinary ClawWorks.

`openclaw doctor` migrates older config shapes; the runtime only reads the
current shape.

## Giving the router its own model

By default the router plans with the model the run itself dispatches to. That is
the right default — it keeps the routing prompt on a provider the run already
chose — but it ties two unlike workloads together. The turn can be long and
tool-heavy; the router makes **one** small structured call, capped at 400 output
tokens, before the tool loop starts. More importantly, the router goes through the
direct completion API, while a CLI backend runs the turn by handing it to a binary
that authenticates itself. Such a run has no API credential to lend the router, so
it cannot be planned at all and the default tree governs.

Name a router model when either applies:

```jsonc
{
  "enterprise": {
    "mode": "enforce",
    "routePlanner": {
      "model": "mistral/mistral-medium-3-5",
    },
  },
}
```

A plain `provider/model` ref, and the provider half is required — a bare
`mistral-medium-3-5` is rejected, because it would resolve against whatever the
agent's default provider happens to be and this setting exists to say where routing
may send the prompt. Gateway providers route slash-bearing ids, so
`openrouter/mistralai/mistral-medium-3.1` is fine: only the first segment is the
provider. The router makes one bounded call and owns its own deadline, so there is
no fallback list or timeout to set here.

Three consequences worth knowing:

- **The router picks its own credential.** An auth profile names an account inside
  one provider, so the run's pinned profile is not forwarded to a router on a
  different one.
- **It overrides the gates that exist because the run's model is unknowable** — a
  provider-only run, or a `before_model_resolve` hook that may swap the model
  later. Naming a router answers the question those gates were guessing at: where
  the routing prompt may go. The gates about whether a run plans **at all** still
  decide first, so an ACP run (its backend is not ours to pick) and a cron turn a
  `before_agent_reply` hook may answer without dispatching are still not planned —
  naming a router never buys a routing call for work that never runs.
- **The allow-list is not involved.** `agents.defaults.models` gates agent model
  overrides; the router resolves through the completion runtime, which does not
  consult it.

Set up the router's provider auth first — that is what registers its catalog, and
the router resolves through provider discovery rather than a hard-coded list. The
gateway also warms this provider at startup so the first governed turn is not the one
that discovers it. A router added to config needs a gateway restart, since the
gateway reads config at startup.

Pick for routing judgment, not context size: the prompt is small, and what matters
is whether the model picks the deepest node covering a request instead of hedging
up to its parent.

## Workflow trees

A workflow tree is a versioned, importable definition. Each node is a step; leaf
nodes are the executable steps a run advances through.

The field-by-field format reference, in YAML and JSON, is
[Worktree Authoring](/concepts/clawworks-worktree-authoring).

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
        mcpServers: [acme-tracker]
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
step: a step whose scope refuses `read` gets the instructions all the
same, on embedded and CLI-backed runs alike. (ACP is the exception; see below.)

What is inlined is the `SKILL.md` itself, without a path — mediation runs before
a sandboxed run materializes its own copies, so a location rendered here would be
one that run cannot use. A skill that delegates detail to support files next to
it (`references/…`, `scripts/…`) therefore needs `read` reachable on the step (it
is on the core floor, so only a `deniedTools` entry or a policy takes it away)
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

One worked example ships in the source repository, and it is a bundle rather than
a tree so that every governed axis is live on import: a tree cannot carry its own
knowledge, so `knowledge_search` on one retrieves nothing until you register its
foundations yourself. From a source checkout:

```bash
pnpm openclaw enterprise bundle import examples/enterprise/financial-operations.clawworks-bundle.yaml
pnpm openclaw gateway restart
```

The restart is required: a running gateway holds its tree registry for the life
of the process, so an import made from the CLI is not visible to the Control UI
or to runs until it reloads.

It is a regulated financial-services operation under governance — customer
lifecycle, financial-crime risk, claims, and regulatory reporting — at the scale
where the bindings actually constrain each other: 46 nodes across 30 executable
steps, depth 5, so route selection is a real problem, an object model declared per
domain so claims cannot address a `sar`, six inlined corpora with one shared
across two domains and two locked to a single domain, four MCP servers attached to
the steps that need them and denied everywhere else, nine ontology writes, and `capabilityGrants: explicit`
so every one of those is deny-by-default. The one thing a bundle cannot carry is
the MCP servers themselves — their transport and credentials are deployment
configuration — so register `acme-screening`, `acme-ledger`, `acme-tracker` and
`acme-filing` under `mcp.servers` and the attachments resolve. Everything else
runs on a stock install.

Then open Enterprise and select the work-map on Worktree. The Tools and Skills
screens list the catalog for the gateway's default agent — tools resolve against
an agent's workspace and skills against its filter, so a multi-agent install has
no single catalog, and the screens name the agent they answered for. Each entry
the selected work-map binds is tagged with the steps that use it; a skill a step
declares but no install provides is listed too, marked "not installed".

### Ontology bindings

Each node carries executable metadata in its `ontology`:

- `allowedTools` / `deniedTools`: tool name globs. `allowedTools` is what a step
  may call **without asking**; a tool no list on the root-to-active path names
  raises a one-off human approval instead of running, and is refused if nobody
  answers. `deniedTools` is the hard refusal, and deny wins over allow. Each node
  on the root-to-active path is an independent gate, so a leaf inherits every
  ancestor's scope. Under
  [explicit capability grants](#capability-grants) an omitted list grants nothing
  approval-free, apart from the reply-and-read floor described there.
- `knowledgeFoundations`: knowledge foundation ids the step may query. Empty or
  omitted allows every configured foundation, except under
  [explicit capability grants](#capability-grants), where the list IS the grant.
- `mcpServers`: MCP servers the step may call, by their `mcp.servers` config
  name. This is the one scope that DENIES by default — but only for a work-map
  that uses it: attach a server anywhere in the tree and every step is governed,
  so a step without an attachment can call none. A work-map that never mentions
  the field keeps the behavior it had before it existed. An attachment is
  inherited down the branch and grants that server's tools without the step also
  listing them in `allowedTools`; `deniedTools` still wins, so a step can take one
  tool back. [Explicit capability grants](#capability-grants) turn the same rule
  on for a work-map that attaches no server at all.
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

### Capability grants

A work-map decides how its steps get capabilities at all:

```yaml
schema: clawworks.workflow-tree
schemaVersion: 1
id: acme.financial-operations
capabilityGrants: explicit
```

With `capabilityGrants: explicit`, **tools, skills, MCP servers, and knowledge
foundations are all deny-by-default**: a step reaches only what it or a step above
it attaches. Skills, MCP servers and knowledge foundations are withheld outright.
Tools work slightly differently, and the difference matters when you are reasoning
about the boundary — read on.

- **Tools**: `allowedTools` controls what a step may call **without asking**. A
  call no list on the root-to-step path names is not refused outright: it raises a
  one-off human approval, and runs only if someone allows it. So the list is the
  approval-free set, not a wall.

  **`deniedTools` is the wall.** That, and a `deny` governance policy, are what
  refuse a call outright — on any step of the path, and on the floor tools below
  too. If a step must never touch something, deny it; do not rely on leaving it
  out. The lists still narrow as they nest (a leaf cannot widen its root's
  approval-free set).

  An unanswered approval always refuses. A policy that would otherwise allow on
  timeout cannot relax a call the step's scope never covered.

  Three of OpenClaw's own tools are the exception and stay available:
  `message`, `read` and `memory_search`. Deny-by-default is
  about the enterprise capabilities an operator assigns — MCP servers, skills,
  knowledge foundations, ontology actions — not about whether the agent can
  answer or look at anything. Without that floor a step granted one knowledge
  source could read the handbook and then be unable to reply, which is not a
  restriction anyone chose; it is what silence happened to mean. `exec`, `write`
  and `edit` are deliberately NOT on the floor: those are what an explicit
  work-map exists to control. An operator can still take a floor tool back with
  `deniedTools`, which the floor never overrules.

- **Skills**: the run's skill catalog is narrowed to the skills its steps
  declare. A skill no step attaches is not offered to the model, not materialized
  for a CLI harness, and its `skills.entries.<name>` credentials are not injected
  for the run — nor handed to a CLI subprocess the run starts. Nothing is
  installed or uninstalled by this; the agent's own skill filter still applies
  first, so a work-map can only narrow what the agent already had.
- **Knowledge foundations**: a step queries only the foundations its path names.
  Without the switch an omitted or empty list means every configured foundation,
  which is the right default for a work-map that scopes nothing — but it is the
  opposite of what an explicit work-map means by silence. A `knowledge_search`
  that targets an ungranted foundation is reported as skipped, never widened, and
  the tool is not offered at all when no executable path grants a foundation the
  deployment has.

  This one applies in **observe mode too**, unlike the three above. Knowledge
  scope has never been something observe relaxes — a step's own list has always
  filtered retrieval — so the grant is read the same way in both modes, and an
  observing dry run shows exactly what enforce will do.

- **MCP servers**: already deny-by-default whenever a work-map attaches one
  (above); explicit grants turn the same rule on for a work-map that attaches
  none, and additionally withhold a plugin's MCP servers from a native runtime
  unless the root's `allowedTools` grants them whole. On the Claude CLI and the
  Codex app-server the attachment alone is not enough to CALL the server — those
  report a tool name with no MCP origin — so the root must also list the server's
  tool globs, in every spelling (see
  [What that means for a governed native run](#mcp-servers)).

Omit the field for the inherited semantics every work-map written before it
carries: a scope narrows what an ancestor allowed, and a branch that scopes
nothing may use anything. That is the default because `allowedTools` and `skills`
predate this switch — a stored work-map that scopes one leaf means "narrow that
leaf", and silently rereading it as "deny everywhere else" would break an import
on upgrade.

The Control UI shows which mode a work-map is in on **Enterprise -> Worktree**,
next to the work-map's name, and switches it there. Switching writes an ordinary
revision, so the version history can restore the previous mode.

One gap is worth stating plainly. Skill credentials are injected into the
gateway's **process** environment, shared by every run in it. A governed run
never injects a withheld skill's key, and the subprocesses it starts (a CLI
backend, the Codex app-server) have those keys removed even when a concurrent run
put them there — but a governed run allowed to `exec` reads that environment
in-process, so it can still see a key a DIFFERENT, concurrently running session
injected for a skill it was granted. That is a property of the process-wide skill
environment (the same crossing exists between any two sessions with no enterprise
involved), not of capability grants; closing it needs per-run credential
isolation in the skills runtime. Keep skills whose credentials must not cross
runs on their own agent until then.

**ACP turns are outside this boundary.** A turn dispatched to an ACP agent runs
in a process ClawWorks does not supply tools to, and its calls never reach the
per-call gate, so an explicit work-map does not constrain what that agent does —
its own tool and MCP surface applies. The run is still traced and its run-start
policies still evaluate. Do not rely on capability grants to bound an ACP-backed
agent; scope that agent itself.

Three limits are worth knowing. The run digest tells the model the rule and lists
each step's grants, so it does not spend turns discovering denials — but the
enforcement is the per-call gate, not the prompt. A CLI backend with no pre-tool
hook judges no call at all: there, skills and MCP servers are withheld physically
(nothing is linked, nothing is launched), while `allowedTools` bounds only what
ClawWorks hands over. And a run that never advances — because the model never
called `complete_step`, or because the runtime receives no OpenClaw tools at all
(ACP) — is judged by its FIRST step's grants merged with the root's for the whole
run, so a work-map that holds its grants on later leaves gives such a run nothing.
Put what every step needs on the root, exactly as an MCP-attaching work-map does.

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
3. **Step advancement** moves the active node from one step to the next when the
   model calls `complete_step`, so a step lasts as long as its work does instead
   of expiring after one provider turn.
4. **The tool-call gate** evaluates each tool call against the active node's
   ontology merged down the root-to-active path, then against config governance
   policies.

A tool call the step's scope does not cover **asks rather than fails**. A work-map
cannot anticipate every tool a real request needs, and a silent refusal leaves an
operator with a run that failed for reasons only the trace explains — so an
omission (an `allowedTools` list that does not mention the tool, or nothing
granting it under explicit grants) raises an _Allow once / Deny_ approval naming
the step and where the lasting fix belongs. Nothing runs unapproved, and it fails
closed: the approval times out to deny, and a run with no interactive channel —
cron, headless — resolves it as a refusal rather than passing it.

Two things stay hard blocks, because both are decisions somebody made rather than
omissions: an entry in a step's `deniedTools`, and a `deny` policy in
`enterprise.governance.policies`. Escalating those to a prompt would make writing
one mean nothing. A denial also wins wherever it appears on the path, including on
a step _below_ the one whose list omitted the tool.

Two more cases cannot reach the prompt at all, because the decision is taken before
any tool call exists:

- **Codex hosted tools.** `web_search` on a Codex app-server run is granted once,
  before the thread starts, and Codex executes it itself outside registry dispatch,
  so no per-call gate ever sees it. If any step the run can reach omits it, it is
  withheld for the whole run rather than prompted for. Grant it on every reachable
  step, or expect it to be absent.
- **Ontology writes.** `invoke_action` needs an explicit opt-in on the active path
  (the tool named in `allowedTools`, or `group:enterprise-write`). A step without
  that opt-in is refused outright rather than prompted, because the tool is exposed
  plan-wide for prompt-cache stability and the opt-in is the only thing separating a
  step that may write from one that merely sees the action declared.
- **MCP servers on a native backend.** A CLI or Codex subprocess receives its MCP
  servers once, at launch, and nothing can hand one over later — so a server no
  reachable step attaches is never written into that subprocess's config at all.
  There is no tool call to approve, because the tool was never offered. See
  "MCP servers" below for what that ceiling reads.

**On the Codex app-server, a work-map that scopes tools changes how they are
registered.** Codex's default `searchable` mode puts ClawWorks tools under a
namespace and concatenates namespace and tool with no separator when it names a
call to its PreToolUse hook (`flat_tool_name` in `codex-rs/core/src/tools/mod.rs`),
so `knowledge_search` arrives as `openclawknowledge_search` — a spelling no rule
an operator can write, read as out of scope, refusing a tool the work-map DOES
grant. Nothing downstream can repair it: that flattened string is the only identity
the hook carries, and a namespace and a tool cannot be told apart once joined.

So a run whose work-map decides tool calls by name registers those tools
**directly**, under their real names, for the whole turn. That means any step
naming `allowedTools` or `deniedTools`, any work-map under
[explicit capability grants](#capability-grants), or any governance policy
targeting the bound tree. A run that scopes nothing — the default
`clawworks.assist` binding a request no work-map claimed — keeps searchable
registration, so a stock install is unchanged.

The tradeoff is deliberate. Direct registration puts the tools in the turn's
opening context instead of behind Codex's tool search, which costs prompt space on
a governed turn. A work-map's rules meaning what they say is worth more than that,
and a governed run's tool surface is the one the operator chose.

Setting the Codex plugin's `codexDynamicToolsLoading` to `"direct"` does the same
thing for every run; it is no longer needed for governance and remains a
preference. A side question (`/btw`) forks the parent thread and inherits the
tools it registered, so it follows whatever the parent turn used.

**A session attached with `/codex resume` is the exception.** Codex accepts a tool
catalog only when a thread STARTS — `thread/resume` has no field for one, and a
resumed thread restores the catalog it was created with. So an attached thread
keeps whatever names it already registered, and a governed turn on it can still be
judged on flattened names and refuse tools the work-map grants. Replacing the
catalog would mean abandoning the thread the operator deliberately attached, along
with the history that is the reason to attach it, so ClawWorks keeps the thread.
For governed work on such a session, start a new one, or set
`codexDynamicToolsLoading` to `"direct"` before the thread is created.

The hook stays synchronous and short-lived either way, so on Codex a scope
omission is REFUSED rather than prompted: the approval would outlive the harness
deadline. Grant a Codex work-map what its steps need rather than relying on the
approval path.

A run opens on the first step of its route, not on the root. Because advancing is
a tool call rather than a property of one runtime's loop, every runtime that
receives OpenClaw tools can walk the route: the embedded runtime, the CLI
loopback surface, and the Codex app-server. ACP runs own their own tool channel
and receive none of ours, so they stay on the step they opened on for the whole
run.

`complete_step` is deliberately the only way forward. Advancement is monotonic
and one step at a time, so the worst a confused model can do is finish a step
early — which the trace records — and it can never reopen a step it has left. A
step the run never finished stays `entered` with no matching `node.completed`,
which is exactly how an abandoned or interrupted route reads in the trace.

Steps are anchored to the conversation rather than tagged onto every message.
The one `complete_step` call that closes a step is also where the next one
begins, so when that call carries a caller-visible id it is recorded on the
closing step's `node.completed` and the opening step's `node.entered` alike,
giving the pair an explicit transcript span. This is what lets a step that was
entered and then abandoned still resolve to a transcript position instead of
vanishing — its `node.entered` anchor places its work even though no
`node.completed` ever closed it.

Two boundaries carry no such id, and there attribution stays at the run level —
its `session_id` names the whole conversation, shared by every node on the
route. The run's opening step begins at the start of that transcript, so it has
no preceding `complete_step` call to anchor to. And the CLI loopback mints a
tool-call id that is private to our MCP server and never reaches the caller's
transcript, so steps advanced across it are left to the run-level link rather
than a per-step span. The trade is deliberate: node attribution costs no
per-message storage.

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

## MCP servers

MCP servers are registered the ordinary ClawWorks way — one entry under
`mcp.servers` — from **Enterprise -> MCP** in the Control UI, from the MCP
settings screen, or with `openclaw mcp add`. Registration alone does not make a
server reachable from a governed run.

Under enterprise governance a registered server is callable only from the steps
that attach it — once the work-map opts in. A work-map that never mentions
`mcpServers` and does not [grant explicitly](#capability-grants) is not governed
by attachments at all: its runs reach every registered server as ordinary tools,
exactly as they did before this field existed. Attaching one server anywhere in
the tree (or turning on explicit grants) switches the whole work-map to
deny-by-default:

```yaml
- id: support.resolve
  title: Resolve or escalate
  ontology:
    mcpServers: [acme-tracker]
```

Everything else about MCP is unchanged: the servers, their transports, their auth,
and their tools are the same ones the rest of ClawWorks uses. What the workflow
tree adds is reach. A step that attaches nothing calls nothing, so a server
registered for one workflow cannot be used by a step that was never given it.

The Enterprise MCP screen shows each registered server with the steps of the
selected work-map that attach it, and labels the two states that are easy to
misread: a server no step attaches (registered, unreachable) and an attachment
naming a server config does not register (inert — nothing launches under that
name).

With `operator.admin` the same screen registers one. **Register an MCP server**
takes either half of the form:

- _Type it_ — a name plus one transport: a command with space-separated
  arguments, or an `http(s)` URL with the transport named explicitly.
- _Paste JSON_ — the snippet the server's own docs publish. An `mcpServers`
  block (Claude Desktop and most vendor docs), a `servers` block (VS Code), an
  OpenClaw `mcp.servers` block, or a bare name-to-server map are all accepted,
  and everything travelling with the entry — `env`, `headers`, `cwd`,
  `toolFilter`, TLS, OAuth — is written through untouched. Several servers in one
  snippet register together, or none of them do: a name that collides with an
  already-registered server refuses the whole paste rather than registering half
  of it. A `"type"` alias is rewritten to OpenClaw's `transport` field, the same
  rewrite `openclaw mcp add` applies. A URL entry that names no transport is
  registered as `streamable-http` and the preview says so — an unset transport is
  read as SSE by the embedded runtime and as streamable HTTP by Codex, so one
  entry would otherwise dial two different servers.

Either way the screen writes the same `mcp.servers` config draft the Settings MCP
screen writes and leaves Save/Publish to it; registering does not attach the
server to any step.

Only servers an operator registered under `mcp.servers` are gated this way. A
server a plugin contributes arrives with that plugin's tool surface and cannot be
attached here — the Enterprise MCP screen does not register it, so requiring an
attachment would take a working plugin away from every governed run with no way to
grant it back.

It is still scoped by `allowedTools` like the rest of that plugin. On the embedded
runtime the per-call gate does that. On a backend with no pre-tool hook nothing
judges a call afterwards, so the same ceiling is applied at launch instead: a
plugin server the root's list cannot admit whole — or that a denial or a blocking
policy reaches — is not handed over. A root that narrows nothing hands over
everything, as before.

An MCP tool is recognized by what it _is_, never by how its name reads: every tool
the MCP runtime materializes carries the server it came from, and the per-call gate
reads that registration. A core tool spelled like `<server>__<tool>` is therefore
never mistaken for one.

That registration exists on the embedded runtime. A native harness (Codex, the
Claude CLI) reports tool calls through a hook that carries no origin and passes
ordinary tool names through verbatim, so nothing there distinguishes an ordinary
`foo__danger` from server `foo`'s `danger`. Guessing would hand that ordinary tool
the attachment's grant, so the gate does not guess — native runs are bounded where
the mapping is exact instead, at launch, by what is handed over.

**What that means for a governed native run:** the attachment decides whether a
server is reachable at all. On the embedded runtime it additionally grants that
server's tools, so `allowedTools` need not name them; on a native runtime a step
that narrows `allowedTools` must name them as it would any other tool — with both
spellings, since each runtime renames the server its own way. Under
[explicit capability grants](#capability-grants) this is not optional: those
runtimes report a flattened tool name with no MCP origin, so the gate cannot tell
the server's tool from an ordinary one, and a step that grants no tools grants
none of the server's either. Attach the server AND list its globs:

```yaml
ontology:
  allowedTools:
    [message, "acme-tracker__*", "mcp__acme-tracker__*", "acme_tracker__*", "mcp__acme_tracker__*"]
  mcpServers: [acme-tracker]
```

Every spelling, not just one: the harness decides which name it exposes (ClawWorks
maps punctuation to `-`, Codex to `_`, and either may carry the `mcp__` prefix), so
a list that covers only some of them leaves the rest outside the ceiling — and a
native run withholds the server rather than hand over tools it cannot bound.

### What the boundary does not cover

Attachment governs the servers **ClawWorks hands over**. A harness that reads its
own configuration is a second source, and ClawWorks's projection is an overlay on
top of it: Codex merges its configuration layers table by table
(`merge_toml_values_at_path`, `codex-rs/config/src/merge.rs`), so an overlay can
add or change keys but never remove a server a lower layer declared. A server
written into the Codex config file therefore starts for a governed run too, and a
lower-layer entry that shares a name with a registered one contributes its own
fields to the merge.

That layer belongs to the harness, not to the gateway. Keep the servers a work-map
should govern in `mcp.servers`, where the Enterprise MCP screen can see them, and
treat MCP servers in a harness's own config the way you would treat anything else
installed on the host.

A bundle exported from a work-map records the server names it attaches
(`requiredMcpServers`), and importing one reports them: a server is deployment
configuration, so the bundle carries the name and the recipient registers the
server itself.

Put those globs on the ROOT as well when the tree narrows tools there: the root
sits on every step's path, so its list bounds every call the run makes wherever it
has advanced to — and on a CLI with no pre-tool hook it also decides whether the
server is handed over at all (a server the root's list cannot admit is withheld,
not merely denied later). A tree that narrows nothing needs none of this; the attachment is
the whole rule there.

A `deniedTools` entry may be written with either the configured server name or the
runtime's rewritten one; both cover an embedded call.

One rewrite cannot be read back, though. Codex disambiguates a collision — and
fits a name into its 64-character budget — with a hash of an identity computed on
its side, so a denial copied from a model-visible name like
`mcp__github__read_a1b2c3d4e5f6` names an operation nothing here can identify. The
embedded gate does not drop such a rule: it applies it to the whole server for that
step. Write the denial with the configured name (`github__read`) to keep the rest
of the server callable.

A harness may rewrite an identity past recovery — Codex truncates a callable name
at 64 characters and disambiguates a collision with a hash suffix — so a per-tool
denial cannot be matched against what it reports. Rather than resting the boundary
on a name that would have to be guessed at, a server the work-map **both attaches
and partially denies is never handed to a native runtime**: it is withheld at
launch, exactly like an unattached one. Per-tool denials inside an MCP server are
enforced on the embedded runtime, where every call carries its registration.

A denial that cannot reach the server's tools (`exec`, say) does not withhold
anything — only one that names the server, or a pattern that opens with a wildcard
and could therefore reach it.

Attachments match `mcp.servers` keys exactly — those keys are free-form and
case-sensitive, so `github` and `GitHub` are two different servers.

Registering a server here writes the same `mcp.servers` entry as anywhere else,
including an explicit `transport`. The two HTTP transports are not interchangeable
(`streamable-http` and `sse`), and an entry that omits it is read differently by
different runtimes, so the form asks which one it is.

CLI-backed runtimes (including the Codex app-server) launch their MCP servers
themselves, from config the subprocess owns, so nothing can be withdrawn once that
process is up. For those, ClawWorks withholds the servers **no step in the bound
work-map attaches** — they are never written into the subprocess config or the
Codex thread patch. Two consequences follow, and both are deliberate:

- What is handed over is decided once, across every step the run PLANNED — not
  the whole definition: a branch the route left out is not going to run, and
  handing over its server would let the selected branch call it. That launch-time
  ceiling is all a CLI backend with no pre-tool hook ever gets. Where a gate does
  exist — the embedded runtime, and Codex through its hook relay — each call is
  still narrowed to the step the run has actually reached, so a server attached to
  a later step stays denied until `complete_step` gets there.
- Withholding removes what ClawWorks would have injected. A server the operator
  declared in the harness's own configuration is a layer ClawWorks does not own —
  Codex, for instance, composes `mcp_servers` by key across its config layers and
  a thread patch is the session layer.

Anything that would have blocked a call counts the same way, because on a runtime
with no per-call hook nothing evaluates it later: a governance policy that denies
or requires approval for a tool the server exposes withholds the server at launch,
and so does a root allow-list that grants it only in part — `allowedTools` stays a
ceiling, so `<server>__*` is how a step grants a server to a native runtime.

Observe mode withholds nothing: it records decisions without blocking, and
removing a server is physical rather than recorded.

Only `mcp.servers` entries are attachable. A server that reaches a Claude backend
through an inherited `--mcp-config` file is operator-supplied but not registrable
here, so a governed run withholds it outright rather than letting an attachment
that this screen reports as unregistered quietly launch it.

Servers a plugin provides are not attached this way. They arrive with that
plugin's tool surface and stay scoped by `allowedTools` like the rest of it, and
so does ClawWorks's own loopback MCP server.

### Hosted tools

A native harness can also offer tools it never dispatches itself. Codex's
`web_search` is one: the model host runs it and returns the result, so the call
reaches no local tool handler and fires no `PreToolUse` hook. The per-call gate
therefore cannot see it — not even on a backend that relays hooks — and the only
enforcement point is the decision to enable it at all, taken before the thread
starts.

ClawWorks takes that decision from the same ceiling the MCP withholding uses: the
root's `allowedTools` (a grant on a leaf a native run can never reach does not
count), any planned step's `deniedTools`, and, under
[explicit grants](#capability-grants), the absence of a grant. So a work-map whose
root allows `[knowledge_search, message]` turns Codex's hosted web search off for
that run, and one that narrows nothing leaves it exactly as configured. Observe
mode changes nothing here either — withholding a tool is physical rather than
recorded.

The practical consequence is worth stating plainly: **enterprise mode alone does
not restrict tools.** Until an imported work-map governs the run, every request
binds the guidance-free default tree (`clawworks.assist`), which scopes nothing —
so the assistant may still search the web, exactly as it would outside enterprise
mode. Import a work-map to change that.

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
servers.

The Knowledge screen registers one without hand-editing config. With
`operator.admin`, **Connect a knowledge source** offers a form built from the
adapter's own config schema: the foundation id and server URL every adapter
declares, plus whatever else it defines — the adapter's enum values become
selects, its field descriptions become the help text, and a field the gateway
redacts is masked. Leaving an optional field blank writes nothing, so the
adapter's own default stands. Submitting appends the entry to that plugin's
`foundations` list and sets its `enabled` flag, then leaves Save/Publish to the
config controller; nothing is retrievable until the config is published and the
adapter loads it.

Every source that plugin's config declares is listed below the form with **Edit**
and **Remove**, and the ones not yet saved are marked. Editing rewrites the entry
at its own position: values the form does not render survive, and a stored
credential comes back blank and marked unchanged, because the gateway redacts it
on the way out and swaps the real value back in on save.

Removing is refused when a _later_ source still holds a stored credential. The
gateway matches redacted values by array position, so deleting an entry would
shift the next one into a slot whose stored key is not theirs; the screen names
the source in the way instead of silently mismatching a credential. Edit that
source and re-enter its secret first. The config editor is **not** an
alternative: it saves through the same positional restoration path and carries
the identical hazard.

Which plugins the screen offers is discovered from the config schema, not from a
built-in list: any plugin whose config declares a `foundations` array of objects
with a string `id` and a string `serverUrl` is offered, so a third-party
knowledge adapter following the same shape gets this form with no core change.

The config the form writes is the same block you can write by hand:

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
  retries), and `enterprise.objects.list` — all `operator.read`.
  `enterprise.runs.resume` is admin-scoped, because it decides where governed
  work resumes rather than what an operator can see. Editing the
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
    With `operator.admin` the whole of that node's ontology is editable in place —
    object types and their fields, links, the **actions** `invoke_action` may run
    (each with its effects and parameters), and the **derived values**
    `compute_function` evaluates. The two verbs carry checks the import does not:
    an effect resolves against the step's own root-to-node path and a write effect
    needs the type's identity field, and a function's expression is parsed and its
    property reads checked against what the step can address — so a definition the
    importer would accept but the runtime could not resolve is refused at the
    field. An action with no create/update/delete effect is flagged, because the
    write path refuses to run one. Seeded `objects` and `links` are still authored
    by importing the work-map.
  - _History_ lists recent runs and shows a per-execution inspector with the plan
    steps, their ontology scope, and the governance trace.
  - Continuing an interrupted run happens there too. An execution that ended part
    way through its route offers **Continue this run** to `operator.admin`
    operators; it does not start anything. It arms that execution, and the next
    request in the same session, from the same agent, that routes to the same
    work-map, in the same transcript, and started after you clicked, opens on the
    first step the run did not finish instead of starting the work-map over.
    Requests routed elsewhere leave it armed; background runs (heartbeats, memory
    flushes) never consume it, and neither does a turn already in flight when you
    clicked, nor an exec-approval followup — the runtime continuing its own
    earlier work is visible and tagged like a typed turn, so the gateway marks it
    as what it is. `/new` and `/reset` end it: the marker is bound to the transcript
    whose steps it continues, so it never applies in a conversation that did not
    see them. It applies once and is traced as `run.resumed`, which carries the
    finished-step prefix forward so a route interrupted several times keeps
    accumulating progress.

    Resuming is never inferred. Same session, same work-map, same revision and a
    previous run left `aborted` still cannot separate "carry on with that work"
    from "a new request that routes the same way", and guessing wrong opens a run
    partway through a governed route — so an operator names the execution.
    A run still going, one attached to no session, one that finished no step, and
    one that finished its whole route are all refused with that reason.

  - _Knowledge_ lists every registered foundation with its kind, connection
    status, and the steps that reference it, manages documents for the ones this
    deployment administers, and — with `operator.admin` — registers a new one
    from an adapter plugin's config (see [Knowledge foundations](#knowledge-foundations)).
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

- [Worktree Authoring](/concepts/clawworks-worktree-authoring)
- [`openclaw enterprise` CLI](/cli/enterprise)
- [LightRAG knowledge plugin](/plugins/reference/lightrag)
- [Agent loop](/concepts/agent-loop)
