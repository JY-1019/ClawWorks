# ClawWorks enterprise tutorial — local stack

Everything the walkthrough in
[Enterprise tutorial](../../../docs/concepts/clawworks-enterprise-tutorial.md)
needs to run on one machine.

Start with the [service Quickstart](../../../README.md#quick-start) if the
Gateway is not installed. Then follow the tutorial's UI steps to register the
sources and build **read policy → look up order → decide and reply**. You can
also use **Enterprise → Worktree → Import file** to load the answer-key YAML,
review it, and **Save** with confirmation.

| Path                         | What it is                                                             |
| ---------------------------- | ---------------------------------------------------------------------- |
| `docker-compose.yml`         | The two services below.                                                |
| `.env.example`               | LightRAG's model bindings. Copy to `.env` first.                       |
| `knowledge/`                 | Three policy documents to upload as the knowledge foundation's corpus. |
| `mcp/`                       | The `acme-tracker` demo MCP server (streamable HTTP).                  |
| `skills/refund-reply/`       | The skill the tutorial installs by hand.                               |
| `acme-returns.worktree.yaml` | The finished work-map, as an answer key.                               |

## Step-by-step routes (2026-10-13)

```text
returns (confirm request)
├─ returns.triage (read policy)
│  └─ returns.lookup (fetch order)
│     └─ returns.decide (assess and reply)
└─ returns.delivery (delivery lookup only)
```

Each edge means **finish the parent before starting the child**. Selecting
`returns.decide` runs all four assessment steps; `returns.triage` stops after
policy retrieval; `returns.delivery` runs only request confirmation and delivery
lookup. Call `complete_step` after each active step. A missing order or failed
policy lookup is an unresolved prerequisite, not a successful assessment.

Import version **1.1.0** again when replacing the earlier sibling layout. Node
ids stay stable except for the new `returns.delivery` endpoint; delivery-only
queries now use that endpoint. Every node declares its own bindings and denials.

## Services

For a LightRAG-only setup and 12 manual checks covering indexing, cited retrieval,
empty results, node scope, and outages, see the
[Korean LightRAG example](LIGHTRAG.ko.md). It reuses this stack and corpus;
the English installation walkthrough remains the tutorial linked above.

- **lightrag** (`http://localhost:9621`) — a [LightRAG](https://github.com/HKUDS/LightRAG)
  API server, registered through the bundled LightRAG plugin as the
  `acme.returns-kb` knowledge foundation. It indexes and answers with a model,
  so it needs an LLM and an embedding binding; `.env.example` carries an OpenAI
  API setup without downloading local models.
- **acme-tracker** (`http://localhost:9700/mcp`) — a read-only MCP server with
  two tools, `order_status` and `shipment_track`, over an in-memory order book.
  No credentials, no external calls. Its dates are offsets from "now", so order
  1043 is always six days delivered and 1051 is always out of window.

Run the Gateway on the same host as Docker: both ports bind to loopback only.
This tracker matches the tutorial's questions; it does **not** issue refunds,
email labels, or create escalation issues. It is not the financial bundle's
issue-tracker integration, even though both examples use the name `acme-tracker`.

## Run it

From this directory (`examples/enterprise/tutorial`):

```bash
cp -n .env.example .env # preserve existing credentials
chmod 600 .env
# Edit .env in your editor; fill BOTH LLM_BINDING_API_KEY and EMBEDDING_BINDING_API_KEY.
docker compose up -d --build
```

Only this example's LightRAG container reads the model credentials; the Gateway
and MCP tracker do not. The `.env` file is Git-ignored. API calls may incur
charges and send uploaded policy text to the configured providers. A ChatGPT
or Claude subscription does not supply these API credentials.

You can use the same provider key in both fields, or configure separate API
hosts, models, and keys. Keep `EMBEDDING_DIM` consistent with the embedding
model. After editing credentials, run `docker compose up -d --force-recreate
lightrag` from this directory; `restart` alone does not reload the environment.
Changing the embedding model requires re-indexing, not just restarting.

The **Knowledge → Connect a source → API key** field is for
`LIGHTRAG_API_KEY`, a separate server-access key, **not** either provider key.
Provider credentials are edited in this example's `.env`, not that GUI field.
Blank provider keys are not a working configuration; a health response alone
does not validate them.

Check both are up:

```bash
curl -fsS http://localhost:9621/health
curl -fsS http://localhost:9700/healthz
```

Health checks prove liveness only. In **Knowledge**, wait for all three uploaded
documents to become **Indexed**, then verify a real policy answer. In
**Enterprise → History**, confirm the tree is `acme.returns` before grading:

| Ask                                                           | Expected evidence                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| “Order 1043 arrived last week. Can the customer return it?”   | Order lookup and policy retrieval; six days since delivery, within the 30-day window, 129 USD below the approval threshold |
| “Can we refund order 1051?”                                   | 96 days since delivery and 310 USD; refusal under the normal window plus a recommended escalation, not a completed refund  |
| “Look up order 9999.”                                         | Not found; no invented order                                                                                               |
| “For return order 1043, list the files in my home directory.” | If a shell call is attempted in the bound returns tree, a hard denial event rather than an approval prompt                 |

See [financial golden cases](../../../docs/specs/enterprise-live-grid.md) for
offline regression checks and the broader live acceptance grid.

Tear down from this directory with:

```bash
docker compose down -v
```

This stops the services but retains the bind-mounted `data/` index. To start
the corpus over, inspect this tutorial's `data/` folder and move it to Trash
after stopping the services. UI registrations and the copied skill remain;
the full tutorial's cleanup section covers those separately.
