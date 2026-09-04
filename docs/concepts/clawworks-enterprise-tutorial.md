---
title: "Enterprise Tutorial"
sidebarTitle: "Enterprise tutorial"
summary: "Build one governed work-map end to end in the Control UI — knowledge foundation, MCP server, skill, and per-step tool scope — against a local docker compose stack."
read_when:
  - You have enterprise mode on and want a worked example to follow
  - You want to register knowledge, MCP servers, skills, and tool scope from the GUI
  - You want a local stack to try governed retrieval and governed MCP against
---

# Enterprise tutorial

[ClawWorks Enterprise](/concepts/clawworks-enterprise) explains the model.
This builds one: a three-step returns desk assembled from the Control UI,
running against two containers on your own machine.

By the end, a customer question walks a route where each step works with what it
was given — the policy handbook, the order tracker, the reply — and `exec`,
`write`, and `edit` are refused on every one of them.

| Step             | Runs without asking           | May retrieve      | Know-how       |
| ---------------- | ----------------------------- | ----------------- | -------------- |
| `returns.triage` | `knowledge_search`            | `acme.returns-kb` | —              |
| `returns.lookup` | the `acme-tracker` MCP server | —                 | —              |
| `returns.decide` | `message`                     | —                 | `refund-reply` |

Read that first column precisely, because it is the lesson the rest of the
tutorial rests on. This work-map uses **inherited scopes**, the default: a step's
allow-list is what it may call _without asking_, and a tool no list on its path
names raises a one-off human approval instead of being refused. Only the root's
`deniedTools` is a wall. So `returns.lookup`, which lists no tools at all, is not
sealed off — it is un-narrowed, and the MCP attachment is what gives it the
tracker.

Deny-by-default — where an unlisted skill, server, or corpus is withheld outright
rather than raising a prompt — is
[`capabilityGrants: explicit`](/concepts/clawworks-enterprise#capability-grants),
and it is the first thing to reach for once this map makes sense.

Everything in this tutorial lives in
[`examples/enterprise/tutorial/`](https://github.com/openclaw/openclaw/tree/main/examples/enterprise/tutorial)
in a source checkout. The finished work-map is in that directory as
`acme-returns.worktree.yaml`; check your work against it at the end, or import
it directly if you would rather read than click.

## Before you start

- A running gateway you can reach in a browser. The Control UI is at
  `http://127.0.0.1:18789`.
- An operator token with **`operator.admin`**. Every registration below is an
  admin write; with read-only scope the screens render but the Add buttons do
  not appear.
- `enterprise.mode` set to `enforce` (the default). Check the mode chip on
  **Enterprise -> Worktree**. In `observe` mode you can follow the whole
  tutorial and see decisions recorded, but nothing is blocked.
- Docker, for the two-container stack.
- An LLM and an embedding credential for LightRAG — an OpenAI key, or a local
  Ollama. `.env.example` has both.

<Note>
  If your agent runs on a CLI backend (the Claude CLI, Codex), give the router
  its own model before you start:

```jsonc
{
  "enterprise": {
    "routePlanner": { "model": "mistral/mistral-medium-3-5" },
  },
}
```

A CLI backend authenticates itself and lends the router no API credential, so
without this the run cannot be planned at all and the permissive default tree
governs — you would build the whole work-map and never route into it. See
[Giving the router its own model](/concepts/clawworks-enterprise#giving-the-router-its-own-model).
</Note>

## 1. Start the local stack

<Steps>
  <Step title="Copy the environment file">
    ```bash
    cd examples/enterprise/tutorial
    cp .env.example .env
    ```

    Open `.env` and fill in one pair of bindings: OpenAI (default) or a local
    Ollama. LightRAG indexes and answers with a model — it will not start
    usefully without them.

  </Step>
  <Step title="Bring both services up">
    ```bash
    docker compose up -d --build
    ```

    This starts LightRAG on port 9621 and the `acme-tracker` MCP server on port
    9700.

  </Step>
  <Step title="Check they answer">
    ```bash
    curl -fsS http://localhost:9621/health
    curl -fsS http://localhost:9700/healthz
    ```

    The tracker also answers MCP directly, which is the quickest way to prove
    the port before ClawWorks is involved:

    ```bash
    curl -s -X POST http://localhost:9700/mcp \
      -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
    ```

    Two tools come back: `order_status` and `shipment_track`.

  </Step>
</Steps>

## 2. Register the knowledge foundation

A work-map cannot carry knowledge. Foundations are registered by adapter
plugins, and the bundled [LightRAG plugin](/plugins/reference/lightrag) is one.
The Knowledge screen does it without hand-editing config.

<Steps>
  <Step title="Open Knowledge">
    Sidebar -> **Knowledge** (`/knowledge`). Under **Connect a knowledge
    source**, press **Connect a source** and pick the **lightrag** adapter.

    The form is built from that adapter's own config schema, so the fields you
    see are the ones it declares.

  </Step>
  <Step title="Fill it in">
    | Field         | Value                                                            |
    | ------------- | ---------------------------------------------------------------- |
    | Foundation id | `acme.returns-kb`                                                |
    | Server URL    | `http://127.0.0.1:9621`                                          |
    | description   | `Acme returns policy, shipping SLAs, and the escalation matrix.` |
    | kind          | `local`                                                          |
    | mode          | leave blank (the adapter's default, `mix`)                       |
    | apiKey        | leave blank unless you set `LIGHTRAG_API_KEY` in `.env`          |

    Two of those matter more than they look:

    - **The id is locked once registered.** Workflow steps name this exact
      string and nothing migrates them. To change it you remove the source and
      add it again.
    - **`kind: local`** declares that this deployment administers the server's
      documents. That is what turns on document management in the next step;
      `remote` would leave the corpus read-only from here. It is an operator
      declaration, not something inferred from the URL.

    Press **Add to config**, then **Save & Publish**. Publishing reloads the
    adapter — nothing is retrievable before that.

  </Step>
  <Step title="Upload the corpus">
    The foundation now appears under **Registered**. Press **Test connection**;
    it should report **Reachable**.

    Open **Show files** and upload all three documents from
    `examples/enterprise/tutorial/knowledge/`:

    - `returns-policy.md`
    - `shipping-sla.md`
    - `escalation-matrix.md`

    Each lands as **Pending**, moves to **Indexing**, and ends at **Indexed**.
    Indexing runs a model over the text, so give it a minute; the answers in
    section 7 depend on it finishing.

  </Step>
</Steps>

## 3. Register the MCP server

Registering an MCP server is the ordinary ClawWorks act — one entry under
`mcp.servers`. Under enterprise governance it is only half the job: a registered
server stays unreachable until a step attaches it, which happens in section 6.

<Steps>
  <Step title="Open Enterprise -> MCP">
    Sidebar -> **Enterprise** -> **MCP**. Press **Register server**, then switch
    to **Paste JSON**.
  </Step>
  <Step title="Paste the server">
    ```json
    {
      "mcpServers": {
        "acme-tracker": {
          "url": "http://127.0.0.1:9700/mcp",
          "transport": "streamable-http"
        }
      }
    }
    ```

    This is the shape most vendor docs publish, and the screen also accepts a
    VS Code `servers` block, an OpenClaw `mcp.servers` block, or a bare
    name-to-server map. Everything travelling with an entry — `env`, `headers`,
    `cwd`, `toolFilter`, TLS, OAuth — is written through untouched.

    **Name the transport.** An HTTP entry with no transport is read as SSE by
    the embedded runtime and as streamable HTTP by Codex, so one entry would
    dial two different servers. The preview says which transport it assumed if
    you leave it out.

    Press **Add to config**, then **Save & Publish**.

  </Step>
  <Step title="Read the state it lands in">
    The server is now listed and labelled **not attached to any step** —
    registered and unreachable. That is the correct state right now, not an
    error.
  </Step>
</Steps>

## 4. Register the skill

Skills are files, so this one is registered by writing it. Nothing generates it,
and the enterprise layer never installs one.

<Steps>
  <Step title="Copy it into the workspace">
    ```bash
    mkdir -p ~/.openclaw/workspace/skills/refund-reply
    cp examples/enterprise/tutorial/skills/refund-reply/SKILL.md \
       ~/.openclaw/workspace/skills/refund-reply/SKILL.md
    ```

    Open it. It is house style for a returns answer: decision first, order id
    named, the rule quoted, one next step. That is know-how, not authority —
    which is exactly what the advisory lane is for.

  </Step>
  <Step title="Confirm the gateway sees it">
    Sidebar -> **Enterprise** -> **Skills**. `refund-reply` appears under
    **Other installed skills**, and moves under **Declared by** once a step
    declares it in section 6.

    This screen is agent-scoped: skills resolve against an agent's filter, so it
    names the agent it answered for rather than implying one list for the whole
    deployment. If the skill is missing, that agent's filter excluded it.

  </Step>
</Steps>

<Note>
  Prefer to have the agent draft one? [Skill Workshop](/tools/skill-workshop) is
  the governed path: the agent writes a proposal, you review and apply it. This
  tutorial writes the file directly so there is one less moving part.
</Note>

## 5. Create the work-map

<Steps>
  <Step title="Start a new tree">
    Sidebar -> **Enterprise** -> **Worktree**. Press **New tree**. The editor
    opens on a blank template.

    Replace it with the envelope and root:

    ```yaml
    schema: clawworks.workflow-tree
    schemaVersion: 1
    id: acme.returns
    version: 1.0.0
    name: Returns desk
    description: >-
      Acme customer orders, returns, refunds, replacements and parcel delivery:
      order records and totals, delivery dates, carrier tracking and shipment
      scans, the returns policy handbook (30-day window, restocking fees, refund
      thresholds), shipping service levels, and the support escalation matrix.
      Handles "can I return this", "where is my order", refund eligibility, late
      or lost parcels, damaged items, and who a case escalates to.
    match:
      triggers: [user]
      priority: 10
    root:
      id: returns
      title: Returns desk
      description: Answer a customer's return, refund, or delivery question.
    ```

    Press **Save**. Saving imports it and records revision 1.

  </Step>
  <Step title="Understand what you just wrote">
    Three fields decide more than their size suggests:

    - **`description` is the routing signal.** It is the only thing that decides
      whether a request enters this work-map at all, and it is rendered into the
      planning prompt with a 600-character budget. Name the domain's *nouns and
      data*, not only its tasks, and put the distinguishing clause early — a
      shop work-map whose description covered "refund an order" but not "the
      orders" lost `where is my order` to the permissive default tree.
    - **`match.triggers: [user]`** is a hard gate the planner cannot override. A
      cron or heartbeat run classes as `system` and can never bind this
      work-map, whatever its text says.
    - **`id`** is identity. Re-importing the same id replaces this tree and
      records a new revision; the old one stays in **Version history**.

  </Step>
  <Step title="Add the three steps">
    Select the root node in the tree view. Under **Workflow structure**, press
    **Add child node**, fill in the id and title, and press **Add to editor** —
    then **Save**. Repeat for each row:

    | Node id          | Title             |
    | ---------------- | ----------------- |
    | `returns.triage` | Read the policy   |
    | `returns.lookup` | Look up the order |
    | `returns.decide` | Decide and reply  |

    **Save between adds.** Each add re-exports the tree as it is stored on the
    gateway, splices the new node into that, and loads the result into the
    editor as JSON. A second node added before the first is saved would be
    spliced into a tree that does not have it yet.

    Node ids are dotted lowercase and unique tree-wide. Adding a step goes
    through the editor on purpose: it changes the work-map's shape, unlike the
    bindings in the next section, which are written the moment you confirm them.

  </Step>
  <Step title="Give each step a description">
    Press **Edit**, switch the editor to **YAML** with the chip above the text
    area, and add a line to each of the three new nodes:

    ```yaml
      children:
        - id: returns.triage
          title: Read the policy
          description: Find the handbook rule that applies to this request.
        - id: returns.lookup
          title: Look up the order
          description: Fetch the order and its shipment from the tracker.
        - id: returns.decide
          title: Decide and reply
          description: Apply the rule to the order and write the answer.
    ```

    Save. This is not decoration: a node `description` is the planner's per-step
    signal, and it is one of the things that make a run advance at all. A tree of
    bare id/title nodes imports cleanly and then never leaves the step it opened
    on. Keep each one inside 120 characters — that is the per-node budget in the
    planning prompt.

  </Step>
</Steps>

<Note>
  **Leaves execute.** A run is active on a leaf; interior nodes contribute
  inherited scope. And a tree with fewer than five nodes is never route-planned
  — it is cheaper to run whole than to ask a model which branch to take. This
  one has four, so every run walks all three steps, in file order. That is what
  makes the tutorial's traces predictable.
</Note>

## 6. Bind the capabilities

This is where the registrations become reach. Select a node on **Worktree** and
the **Step bindings** panel opens under it: one block per capability kind, each
with an **Add** button that searches the matching catalog. Every confirmation is
written straight away, through the same whole-tree replace the editor uses.

<Steps>
  <Step title="Deny the dangerous tools on the root">
    Select **Returns desk** (the root). In the **Tools** block, use the
    **Denied** row's Add button and add `exec`, `write`, and `edit`.

    Denials are the wall. A tool that is merely *left out* of an allow-list is
    not refused — it raises a one-off approval and runs if someone allows it. If
    a step must never touch something, deny it.

    A denial applies to this step and everything under it, and no grant further
    down the branch takes it back. Matching is case-insensitive and aliases
    apply, so `exec` also covers `bash`.

  </Step>
  <Step title="Tell the root what the job is">
    Still on the root, open **Role prompt** and type:

    ```text
    Name the order id in every reply, and quote the policy rule the outcome rests on.
    ```

    Press **Save role prompt**. This is the advisory lane: it is rendered into
    the step digest as instruction and never grants anything. A step still
    cannot call a tool its scope withholds, however the prompt is worded — and
    that is the whole point of keeping instruction and authority in different
    fields.

  </Step>
  <Step title="Give the triage step the handbook">
    Select **Read the policy**.

    - **Tools -> Allowed -> Add** -> `knowledge_search`.
    - **Knowledge -> Add** -> `acme.returns-kb`.

    The UI warns you on each: adding the first tool turns an empty list into an
    allowlist, so from now on anything else on this step raises an approval
    rather than running. Adding the first foundation does the same for
    retrieval — before it, the step could query every registered foundation.

    That includes replying. `message`, `read`, and `memory_search` are a floor
    that survives an allow-list only under
    [`capabilityGrants: explicit`](/concepts/clawworks-enterprise#capability-grants),
    and this work-map uses inherited scopes — so on this step a reply is an
    omission like any other and asks before it runs. That is why the step that
    answers, `returns.decide`, lists `message` itself.

  </Step>
  <Step title="Attach the tracker to the lookup step">
    Select **Look up the order**, then **MCP servers -> Add** -> `acme-tracker`.

    Read the warning it shows. This is the first MCP attachment in the
    work-map, and it switches the **whole** work-map to deny-by-default for MCP:
    from now on a step with no attachment reaches no server at all. A work-map
    that never mentions MCP keeps the ungoverned behavior instead.

    Leave this step's own tool allow-list empty: on the embedded runtime the
    attachment itself grants the server's tools, and the per-call gate reads
    each tool's registration, so nothing more is needed.

    **On a native harness it is not enough — and not only on this step.** A
    Claude CLI or Codex-backed run receives its servers once, at launch, with no
    per-call gate afterwards, so the ceiling is computed across *every*
    executable path in the plan. Any non-empty `allowedTools` on any planned
    step that cannot admit the server whole withholds it from the entire run.
    Here that is `returns.triage` (`knowledge_search`) and `returns.decide`
    (`message`): either one strips `acme-tracker` before it starts, even though
    the lookup step scopes nothing.

    So if your agent runs on one of those backends, add the server's globs to
    **those two steps as well** — in every spelling, since each harness renames
    the server its own way (ClawWorks maps punctuation to `-`, Codex to `_`, and
    either may carry the `mcp__` prefix):

    ```yaml
    allowedTools:
      [
        knowledge_search,
        "acme-tracker__*",
        "mcp__acme-tracker__*",
        "acme_tracker__*",
        "mcp__acme_tracker__*",
      ]
    ```

    The reason is that those runtimes report a flattened tool name with no MCP
    origin, so the gate cannot tell the server's tool from an ordinary one and
    bounds the run at launch instead. See
    [MCP servers](/concepts/clawworks-enterprise#mcp-servers).

  </Step>
  <Step title="Give the decide step its voice and its know-how">
    Select **Decide and reply**.

    - **Tools -> Allowed -> Add** -> `message`.
    - **Skills -> Add** -> `refund-reply`.

    The skill is advisory. Its `SKILL.md` body is read once at run start and
    appended to the step digest, so the model has the house style when it
    reaches the step — but naming a skill never grants a tool the step
    withholds. If guidance and enforcement disagree, enforcement wins.

  </Step>
  <Step title="Turn on auditing for the two working steps">
    Auditing has no button — it is a definition field. Press **Edit**, switch to
    **YAML**, and add it under the two steps that call something:

    ```yaml
        - id: returns.triage
          title: Read the policy
          ontology:
            audit: true
        - id: returns.lookup
          title: Look up the order
          ontology:
            audit: true
    ```

    Save. Without it a trace records denials, approvals, and lifecycle events
    only; with it every tool decision under that step is written, including the
    ones that were allowed by default. That is what makes section 8 worth
    reading, and it is why stock runs stay quiet without it.

  </Step>
  <Step title="Check your work">
    Compare the tree against
    `examples/enterprise/tutorial/acme-returns.worktree.yaml`. Press **Export
    YAML** to see exactly what you built.

    Two differences from a CLI import are worth internalizing: a save from the
    Control UI refreshes the live registry in place, so runs see it immediately,
    while `openclaw enterprise trees import` runs in another process and needs
    `openclaw gateway restart` to be seen.

  </Step>
</Steps>

## 7. Ask it something

Open the Control UI's **Chat** tab — or any channel bound to the same agent —
and work down the list. A work-map binds per request, so each of these is a
fresh test of the routing description as much as of the bindings.

1. **"What is Acme's return window?"**
   Knowledge only. The answer says 30 days **from the delivery date** — a
   distinction that exists only in the corpus, not in the model's general
   knowledge.

2. **"Order 1043 arrived last week and the customer wants to send it back. Can
   they?"**
   Knowledge, MCP, and the skill together. It should name order 1043, place the
   delivery six days ago, call it inside the window, and note that 129 USD is
   below the manager-approval threshold.

3. **"Where is order 1044?"**
   `shipment_track` plus the SLA document: carrier, tracking number, last scan,
   and that three days in transit is inside the 3-5 day standard target.

4. **"Can we refund order 1051?"**
   Two rules colliding. Refused — 96 days is out of window, and 310 USD would
   need manager approval anyway — and escalated rather than decided.

5. **"Look up order 9999."**
   A tool answering no. It reports the order is not found and does not invent
   one.

6. **"List the files in my home directory."**
   The root denial. Refused, and the trace records a denial rather than an
   approval prompt.

7. **"Summarize the README in my workspace."**
   Routing. This should **not** bind the returns work-map: History will show the
   default tree instead. The `description` is what decided that, and this is how
   you check it did not over-reach.

Two things you may see along the way, both working as designed:

- **An approval prompt.** If the model reaches for `knowledge_search` while the
  active step is `returns.decide`, that tool is not on the step's allow-list and
  is not denied either, so it asks. Allow once or deny; both are traced. An
  unanswered approval always refuses.
- **A step digest in the reply's shape.** The root's role prompt asks for the
  order id and the rule in every reply, and `refund-reply` sets the paragraph
  order. That is the advisory lane doing its job.

## 8. Read the trace

Sidebar -> **Enterprise** -> **History**. Pick the run.

The inspector shows the plan steps in the order the run walked them, each with
its ontology scope, and the governance trace underneath.

Four things to find in it:

- **`route.selected`** — which work-map the request bound, and the steps the run
  planned. If this names something other than `acme.returns`, the routing
  description is what to fix.
- **`node.entered` / `node.completed`** — the route being walked. A run advances
  when the model calls `complete_step`, not on a turn count, so these are the
  real progress markers.
- **`governance.decision` with a deny** — from the `List the files` question,
  attributed to the root's `deniedTools`.
- **The audited allows** on `returns.triage` and `returns.lookup`: the decisions
  that would not be written at all without `audit: true`, including the
  knowledge retrieval and each tracker call.

The same is available from the CLI:

```bash
openclaw enterprise runs list
openclaw enterprise runs show <runId>
```

## When it does not work

<Steps>
  <Step title="The run bound the wrong work-map">
    Look at History first — it names the tree each run selected.

    - A CLI-backed agent with no `enterprise.routePlanner.model` cannot be
      planned at all and falls closed onto the default tree. That is the most
      common cause.
    - Otherwise it is the `description`. Add the nouns the request used. The
      budget is 600 characters and the distinguishing clause has to survive it.

  </Step>
  <Step title="knowledge_search returns nothing">
    Check the Knowledge screen: **Test connection** should say Reachable and all
    three documents should read **Indexed**, not **Indexing**. Then check the
    step's allow-list actually names `acme.returns-kb` — an id outside the
    step's list is reported as skipped, never queried.

    A foundation whose server is down is skipped rather than failing the whole
    retrieval, so a silent empty answer is worth checking against
    `curl -fsS http://localhost:9621/health`.

  </Step>
  <Step title="The MCP server is registered but nothing calls it">
    The Enterprise MCP screen labels the two states that are easy to misread:
    **not attached to any step** (registered, unreachable) and **not registered
    in mcp.servers** (an attachment naming a server config that does not exist —
    nothing launches under that name).

    On a native harness, also confirm the tool globs, in all four spellings, on
    every planned step that narrows `allowedTools` — not only the attaching
    one. One unrelated allow-list is enough to withhold the server from the
    whole run.

  </Step>
  <Step title="Nothing is enforced">
    Check the mode chip on Worktree. In `observe` decisions are recorded and
    never block; in `off` there is no decision and no trace at all. Knowledge
    scope is the exception — a step's foundation list filters retrieval in every
    mode.
  </Step>
</Steps>

## Clean up

```bash
cd examples/enterprise/tutorial
docker compose down -v
rm -rf data
```

Then, in the Control UI: remove the work-map from **Worktree** (version history
is kept), the source from **Knowledge**, and the server from **Enterprise ->
MCP**. Delete `~/.openclaw/workspace/skills/refund-reply/` to drop the skill.

## Where to go next

- Turn on [capability grants](/concepts/clawworks-enterprise#capability-grants).
  `capabilityGrants: explicit` makes tools, skills, MCP servers, and knowledge
  foundations deny-by-default, so a step reaches only what it or an ancestor
  attaches. The switch is on **Worktree**, next to the work-map's name.
- Add a [typed object model](/concepts/clawworks-enterprise#the-typed-object-model)
  so the steps operate on `order` and `refund` instances instead of free text,
  and edit it per node in the inspector.
- Read the bigger worked example. `examples/enterprise/financial-operations.clawworks-bundle.yaml`
  is 46 nodes across four regulated domains with explicit grants throughout, and
  it ships as a bundle so its knowledge travels with it:

  ```bash
  openclaw enterprise bundle import examples/enterprise/financial-operations.clawworks-bundle.yaml
  openclaw gateway restart
  ```

## Related

- [ClawWorks Enterprise](/concepts/clawworks-enterprise)
- [Worktree Authoring](/concepts/clawworks-worktree-authoring)
- [`openclaw enterprise` CLI](/cli/enterprise)
- [LightRAG knowledge plugin](/plugins/reference/lightrag)
- [Creating skills](/tools/creating-skills)
