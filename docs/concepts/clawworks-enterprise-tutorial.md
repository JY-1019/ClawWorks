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

New to the service? Start with the
[README Quickstart](https://github.com/JY-1019/ClawWorks#quick-start) for installation
and the financial UI tour, then return here to connect knowledge and MCP.
This tracker only reads orders and shipments: the finished workflow recommends
the next action, but cannot issue a refund, email a label, or file an escalation.

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
[`examples/enterprise/tutorial/`](https://github.com/JY-1019/ClawWorks/tree/main/examples/enterprise/tutorial)
in a source checkout. The finished work-map is in that directory as
`acme-returns.worktree.yaml`; check your work against it at the end, or choose
**Import file** on **Enterprise -> Worktree** if you would rather read than
click. YAML and JSON files open in the raw editor for review; choose **Save**
and confirm when the definition is ready. File import creates a new id and will
not overwrite an existing work-map; select an existing row and choose **Edit**
for a guarded update.

## Before you start

- A running gateway on the same host as Docker for the loopback URLs below.
  Open its authenticated Control UI with `pnpm openclaw dashboard` from the
  source checkout (default address: `http://127.0.0.1:18789`).
- An operator token with **`operator.admin`**. Every registration below is an
  admin write; with read-only scope the screens render but the Add buttons do
  not appear.
- `enterprise.mode` set to `enforce` (the default). Check the mode chip on
  **Enterprise -> Worktree**. In `observe` mode you can follow the whole
  tutorial and see decisions recorded, but nothing is blocked.
- Docker, for the two-container stack.
- LLM and embedding API credentials for LightRAG. `.env.example` uses OpenAI
  APIs by default; no local model download is needed.

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
    cp -n .env.example .env
    chmod 600 .env
    ```

    Open this example's `.env` and fill in both `LLM_BINDING_API_KEY` and
    `EMBEDDING_BINDING_API_KEY`. The template uses OpenAI APIs without local
    model downloads; compatible providers require matching hosts, models, and
    embedding dimensions. Only the example's LightRAG container reads these
    credentials, not the Gateway. API calls may incur charges and transmit
    uploaded document content to the providers. Keep `.env` out of Git.
    These are model provider keys, not the LightRAG server key entered later
    in the Knowledge screen. After editing `.env`, apply it with
    `docker compose up -d --force-recreate lightrag`; restarting alone does not
    reload environment variables. Changing embedding models requires re-indexing.

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

    These checks prove liveness, not successful LightRAG indexing or model
    configuration. Verify **Indexed** documents and an actual policy query below.
    Return to the repository root for the remaining file-copy commands:

    ```bash
    cd ../../..
    ```

  </Step>
</Steps>

## 2. Register the knowledge foundation

A bare work-map references foundation ids; a bundle can also include inline
knowledge. This tutorial instead connects an external foundation through the
bundled [LightRAG plugin](/plugins/reference/lightrag). The Knowledge screen
registers it without hand-editing config.

<Steps>
  <Step title="Open Knowledge">
    Sidebar -> **Knowledge** (`/knowledge`). Under **Connect a knowledge
    source**, press **Connect a source**.

    The form is built from the adapter's own config schema, so the fields you
    see are the ones it declares. If more than one knowledge adapter is
    installed, a chip row above the fields asks which one; with only LightRAG
    installed the form simply names it.

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

    <Frame caption="The registration form, built from the LightRAG adapter's own config schema">
      <img
        src="/assets/screens/tutorial/knowledge-register-form.png"
        alt="The Connect a knowledge source form with the foundation id, server URL, description, and kind filled in"
      />
    </Frame>

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

    Press **Refresh** beside **Files** to check progress without closing the
    list. The counts separate indexed, indexing, pending, failed, and unknown
    documents; a successful connection check alone does not mean indexing is
    finished. The page-level **Refresh** also reloads the open file list. If
    loading fails, use the same file-list **Refresh** to retry. **Upload document**
    works with the keyboard too: focus it and press Enter or Space.

    <Frame caption="Registered, reachable, and holding the three indexed documents">
      <img
        src="/assets/screens/tutorial/knowledge-registered.png"
        alt="The registered acme.returns-kb foundation, a reachable connection test, and its three indexed documents"
      />
    </Frame>

    **Show files** appears because you declared `kind: local`. A `remote`
    foundation lists no files and offers no upload — the same screen, minus the
    document management this declaration turned on.

  </Step>
</Steps>

## 3. Register the MCP server

Registering an MCP server is the ordinary ClawWorks act — one entry under
`mcp.servers`. Under enterprise governance it is only half the job: once a
work-map attaches any server, every server no step attaches becomes unreachable
to it. That switch is thrown in section 6.

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

    <Frame caption="The pasted snippet, and the entry it would register">
      <img
        src="/assets/screens/tutorial/mcp-register-json.png"
        alt="The Register an MCP server form in Paste JSON mode, with the acme-tracker snippet and a preview of the entry it registers"
      />
    </Frame>

    Press **Add to config**, then **Save & Publish**.

  </Step>
  <Step title="Read the state it lands in">
    The server is now listed, and the screen says what it is not: no work-map
    governs MCP yet, so `acme-tracker` is reachable as an ordinary tool. That is
    the correct state right now, not an error.

    <Frame caption="Registered, and not yet governed by anything">
      <img
        src="/assets/screens/tutorial/mcp-registered.png"
        alt="The Enterprise MCP screen listing acme-tracker, with a notice that no work-map governs MCP yet"
      />
    </Frame>

    Governance starts in section 6: the moment one step attaches this server,
    the whole work-map flips to deny-by-default for MCP, and this screen starts
    labelling any server no step attaches **not attached to any step**.

  </Step>
</Steps>

## 4. Register the skill

Skills are files, so this one is registered by writing it. Nothing generates it,
and the enterprise layer never installs one.

<Steps>
  <Step title="Copy it into the workspace">
    Run from the repository root. The destination below is the default workspace;
    substitute the actual workspace of the agent you will use if it is customized.

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
    Sidebar -> **Enterprise** -> **Skills**. `refund-reply` appears in the
    catalog, marked **workspace** and **eligible**.

    <Frame caption="The skill catalog: installed and eligible, declared by nothing yet">
      <img
        src="/assets/screens/tutorial/skills-installed.png"
        alt="The Enterprise Skills screen listing refund-reply as a workspace skill that is eligible"
      />
    </Frame>

    The list is flat until a work-map declares one. Once a step names this skill
    in section 6, the screen splits into **Declared by Returns desk** and
    **Other installed skills** — which is how you check a declaration reached
    the gateway.

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
    Sidebar -> **Enterprise** -> **Worktree**. Press **New tree**, then fill in
    the guided form:

    | Field            | Value          |
    | ---------------- | -------------- |
    | Tree id          | `acme.returns` |
    | Version          | `1.0.0`        |
    | Name             | `Returns desk` |
    | Triggers         | `User`         |
    | Priority         | `10`           |
    | First step id    | `returns`      |
    | First step title | `Returns desk` |

    Paste this into **Description**:

    ```text
    Acme customer orders, returns, refunds, replacements and parcel delivery:
    order records and totals, delivery dates, carrier tracking and shipment
    scans, the returns policy handbook (30-day window, restocking fees, refund
    thresholds), shipping service levels, and the support escalation matrix.
    Handles "can I return this", "where is my order", refund eligibility, late
    or lost parcels, damaged items, and who a case escalates to.
    ```

    Press **Review definition**. The form validates the ids and opens the generated
    JSON in the raw editor with the schema, routing settings, and first step.
    Inspect or adjust it, then press **Save** and confirm to import it and record
    revision 1.

  </Step>
  <Step title="Understand what you just wrote">
    Three fields decide more than their size suggests:

    - **`description` is the routing signal.** It is the only thing that decides
      whether a request enters this work-map at all, and it is rendered into the
      planning prompt with a 600-character budget. Name the domain's *nouns and
      data*, not only its tasks, and put the distinguishing clause early — a
      shop work-map whose description covered "refund an order" but not "the
      orders" lost `where is my order` to the permissive default tree.
    - **`match.triggers: [user]`** is a hard gate the planner cannot override.
      Keep only **User** selected here, so a cron or heartbeat run classes as
      `system` and can never bind this work-map, whatever its text says.
    - **`id`** is identity. The guided form refuses an id already in the
      registry and **Settings** intentionally does not rename it. Each save
      records a new revision, and the old one stays in **Version history**.

  </Step>
  <Step title="Finish the root">
    Select the root node, then enter this under **Step behavior -> Description**:

    ```text
    Answer a customer's return, refund, or delivery question.
    ```

    Press **Save behavior**. If you need to change the work-map version,
    description, triggers, or priority later, use **Settings**; neither task
    requires YAML or JSON.

  </Step>
  <Step title="Add the three steps">
    Select the root node in the tree view. Under **Workflow structure**, press
    **Add child node** and enter each row:

    | Node id          | Title             | Description                                                   |
    | ---------------- | ----------------- | ------------------------------------------------------------- |
    | `returns.triage` | Read the policy   | Find the handbook rule that applies to this request.           |
    | `returns.lookup` | Look up the order | Fetch the order and its shipment from the tracker.             |
    | `returns.decide` | Decide and reply  | Apply the rule to the order and write the answer.              |

    Press **Add step** after each row. Each add re-exports the stored tree,
    inserts the child, saves it through the whole-tree import path, and records
    a revision immediately. It does not open the raw editor or need a separate
    **Save**.

    Node ids are dotted lowercase and unique tree-wide. A node `description` is
    the planner's per-step signal, and it is one of the things that make a run
    advance at all. A tree of bare id/title nodes imports cleanly and then never
    leaves the step it opened on. Keep each description inside 120 characters —
    that is the per-node budget in the planning prompt.

  </Step>
</Steps>

<Note>
  **Leaves execute.** A run is active on a leaf; interior nodes contribute
  inherited scope. The planner still selects which work-map governs a request.
  Once selected, a tree with fewer than five nodes runs whole rather than pruning
  a branch. This one has four, so a bound run plans all three leaves in file order;
  actual advancement still requires the model to call `complete_step`.
</Note>

## 6. Bind the capabilities

This is where the registrations become reach. Select a node on **Worktree** and
the **Step bindings** panel opens under it: one block per capability kind —
**Tools** (an Allowed row and a Denied row), **Skills**, **MCP servers**,
**Knowledge** — each with an **Add** button that searches the matching catalog.
Every confirmation is written straight away, through the same whole-tree replace
the editor uses.

Every Add opens the same picker: a search box over the catalog, checkboxes, a
free-text box for what no catalog can enumerate (a glob, a group, a skill
installed for another agent), and — above the confirm button — the warning that
says what this particular entry changes.

<Frame caption="Adding knowledge_search to returns.triage. The warning is the lesson: the first entry turns an empty list into an allowlist.">
  <img
    src="/assets/screens/tutorial/bindings-picker.png"
    alt="The binding picker searching the tool catalog for knowledge_search, with knowledge_search checked and a warning that adding the first entry turns the step into an allowlist"
  />
</Frame>

The four blocks are per node, and each of the four steps below binds a different
one. Read each screenshot as the answer to one question: what may this step call
without asking, and what is it refused outright?

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

    <Frame caption="The root: three denials, and nothing else bound. Every step below inherits the wall.">
      <img
        src="/assets/screens/tutorial/bindings-root.png"
        alt="Step bindings for the root node: the Denied tools row holds exec, write, and edit, and the allowed, skills, MCP, and knowledge rows are empty"
      />
    </Frame>

  </Step>
  <Step title="Tell the root what the job is">
    Still on the root, open **Step behavior** and type this under
    **Instructions**:

    ```text
    Name the order id in every reply, and quote the policy rule the outcome rests on.
    ```

    Press **Save behavior**. This is the advisory lane: it is rendered into
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

    <Frame caption="returns.triage: one tool, one foundation, and the root's three denials showing through as inherited">
      <img
        src="/assets/screens/tutorial/bindings-triage.png"
        alt="Step bindings for returns.triage: allowed tools holds knowledge_search, the denied row shows exec, edit and write inherited from a parent step, and knowledge holds acme.returns-kb"
      />
    </Frame>

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

    <Frame caption="returns.lookup: the tracker attached, and no tool allowlist of its own">
      <img
        src="/assets/screens/tutorial/bindings-lookup.png"
        alt="Step bindings for returns.lookup: the MCP servers row holds acme-tracker while the allowed tools, skills, and knowledge rows are empty"
      />
    </Frame>

    **On a native harness it is not enough — and not only on this step.** A
    Claude CLI or Codex-backed run receives its servers at launch, so a separate
    server-exposure ceiling is computed across *every*
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

    Flattened tool names and launch-time availability are separate from runtime
    hooks. Hook-enabled backends, including the Codex hook relay, can mediate
    individual calls; they do not restore a server withheld before launch. Do not
    assume all native backends are hookless. See
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

    <Frame caption="returns.decide: the only step that may speak, and the only one carrying the house style">
      <img
        src="/assets/screens/tutorial/bindings-decide.png"
        alt="Step bindings for returns.decide: allowed tools holds message and the skills row declares refund-reply"
      />
    </Frame>

    Go back to **Enterprise -> Skills** now and the flat catalog has split:
    `refund-reply` sits under **Declared by Returns desk**, with everything else
    under **Other installed skills**.

  </Step>
  <Step title="Turn on auditing for the two working steps">
    Select **Read the policy**, open **Step behavior**, enable **Record detailed
    tool-decision audit events**, and press **Save behavior**. Repeat for **Look
    up the order**.

    Without it a trace records denials, approvals, and lifecycle events only;
    with it every tool decision under that step is written, including the ones
    that were allowed by default. That is what makes section 8 worth reading,
    and it is why stock runs stay quiet without it.

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
   and that it shipped three calendar days ago. The standard target is 3–5
   **business** days; the seven-calendar-day escalation threshold has not passed.

4. **"Can we refund order 1051?"**
   Two rules colliding. Refused — 96 days is out of window, and 310 USD would
   need manager approval anyway. Recommend the escalation path; do not claim an
   escalation was submitted by this read-only demo.

5. **"Look up order 9999."**
   A tool answering no. It reports the order is not found and does not invent
   one.

6. **"For return order 1043, list the files in my home directory."**
   First confirm History selected `acme.returns`. If the model attempts the
   shell tool, the root denial blocks it and records a denial, not an approval
   prompt. A textual refusal without a tool attempt is not proof of the gate.

7. **"Summarize the README in my workspace."**
   Routing. This should **not** bind the returns work-map: History will show the
   default tree instead. The `description` is what decided that, and this is how
   you check it did not over-reach.

Two things you may see along the way, both working as designed:

- **An approval prompt.** If the model reaches for `knowledge_search` while the
  active step is `returns.decide`, that tool is not on the step's allow-list and
  is not denied either, so it asks. Allow once or deny; both are traced. An
  unanswered approval always refuses.
- **A step digest in the reply's shape.** The root's step instructions ask for the
  order id and the rule in every reply, and `refund-reply` sets the paragraph
  order. That is the advisory lane doing its job.

## 8. Read the trace

Sidebar -> **Enterprise** -> **History**. Pick the run.

The inspector shows the plan steps in the order the run walked them, each with
its ontology scope, and the governance trace underneath.

For actual arguments and returned facts, go back to the same **Chat** session,
enable **Toggle tool calls and tool results**, and expand the tool card's
**Tool input** and **Tool output**. History records decisions, not full tool
payloads. A knowledge allow event does not prove a successful lookup: inspect
`knowledge_search`'s `searched` list and returned snippets. If your backend does
not expose these results, keep that evidence check incomplete rather than
inferring success from the final answer alone.

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

From the repository root:

```bash
cd examples/enterprise/tutorial
docker compose down -v
```

This stops the services but keeps the bind-mounted
`examples/enterprise/tutorial/data/` index. To reset that index, inspect that
exact folder and move it to Trash after stopping the stack; do not remove other
Gateway state.

Then, in the Control UI: remove the work-map from **Worktree** (version history
is kept), the source from **Knowledge**, and the server from **Enterprise ->
MCP**. To drop the skill, remove `skills/refund-reply/` from the same agent
workspace used in section 4: `~/.openclaw/workspace/skills/refund-reply/` for the
default, or the customized destination you substituted there.

## Where to go next

- Run the [golden cases](/specs/enterprise-live-grid) to distinguish offline
  regression coverage from live routing, source, and capability acceptance.

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
