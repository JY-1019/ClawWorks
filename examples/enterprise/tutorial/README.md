# ClawWorks enterprise tutorial — local stack

Everything the walkthrough in
[Enterprise tutorial](https://docs.openclaw.ai/concepts/clawworks-enterprise-tutorial)
needs to run on one machine.

| Path                         | What it is                                                             |
| ---------------------------- | ---------------------------------------------------------------------- |
| `docker-compose.yml`         | The two services below.                                                |
| `.env.example`               | LightRAG's model bindings. Copy to `.env` first.                       |
| `knowledge/`                 | Three policy documents to upload as the knowledge foundation's corpus. |
| `mcp/`                       | The `acme-tracker` demo MCP server (streamable HTTP).                  |
| `skills/refund-reply/`       | The skill the tutorial installs by hand.                               |
| `acme-returns.worktree.yaml` | The finished work-map, as an answer key.                               |

## Services

- **lightrag** (`http://localhost:9621`) — a [LightRAG](https://github.com/HKUDS/LightRAG)
  API server, registered through the bundled LightRAG plugin as the
  `acme.returns-kb` knowledge foundation. It indexes and answers with a model,
  so it needs an LLM and an embedding binding; `.env.example` carries an OpenAI
  setup and a local-Ollama alternative.
- **acme-tracker** (`http://localhost:9700/mcp`) — a read-only MCP server with
  two tools, `order_status` and `shipment_track`, over an in-memory order book.
  No credentials, no external calls. Its dates are offsets from "now", so order
  1043 is always six days delivered and 1051 is always out of window.

Any MCP server would do here — the official reference servers
(`mcp/everything`, `mcp/fetch`) are one `docker compose` service away. This one
exists so the governed step has a surface that matches the tutorial's questions.

## Run it

```bash
cp .env.example .env    # then fill in the LLM/embedding credentials
docker compose up -d --build
```

Check both are up:

```bash
curl -fsS http://localhost:9621/health
curl -fsS http://localhost:9700/healthz
```

Then follow the tutorial. Tear down with:

```bash
docker compose down -v
```

`data/` holds LightRAG's index and is created on first run; delete it to start
the corpus over.
