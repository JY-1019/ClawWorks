# A complete assessment inside one deep node

This example routes through five levels to
`operations.orders.returns.cases.assess`. That **one node** owns its MCP server,
knowledge foundation, two entity types, a relationship, an atomic three-effect
action, and an eligibility function. Delivery-only and policy-only requests have
separate neighboring routes; account, billing, and catalog branches are distractors.

## Run it

From the repository root, start the existing fictional order server:

```bash
node examples/enterprise/tutorial/mcp/server.mjs
```

In **Workflows → MCP**, register `acme-tracker` with the Streamable HTTP transport
and URL `http://127.0.0.1:9700/mcp`. If that server is already registered and running,
reuse it. Import `combined-return.clawworks-bundle.yaml` using **Import bundle**.
The bundle includes its policy text; no LightRAG instance is required. Alternatively:

```bash
pnpm openclaw enterprise bundle import examples/enterprise/golden/combined-return.clawworks-bundle.yaml
pnpm openclaw gateway restart
```

The CLI import requires a restart to refresh the running Gateway's registry.
The Control UI import refreshes it immediately. Use an authenticated model with
MCP and tool support. In chat, ask:

> Acme 주문 1043을 MCP로 조회하고 반품 정책을 검색해서 반품 자격을 심사해 줘.
> 사례 CASE-1043과 증거 EVIDENCE-1043을 저장하고 연결한 뒤 계산 결과와 연결된
> 증거를 검증해 줘. 실제 환불이나 메시지 발송은 하지 마.

Use fresh case and evidence ids when replaying. All six tool categories should
run under the same selected leaf, without `workflow_advance` between calls:

1. MCP `order_status`: read the actual fictional order.
2. `knowledge_search`: retrieve `returns/eligibility.md` from `demo.return-policy`.
3. `search_objects`: ensure both new ids are unused.
4. `invoke_action`: `record-return-assessment` creates the case and evidence,
   then links them with `return-has-evidence` in the same transaction.
5. `compute_function`: `return-eligible` evaluates the stored case.
6. `get_neighbors`: verify the persisted evidence and policy source.

| Order      | MCP facts                      | Expected function result                           |
| ---------- | ------------------------------ | -------------------------------------------------- |
| 1043       | Delivered 6 days ago; USD 129  | `true`                                             |
| 1051       | Delivered 96 days ago; USD 310 | `false`                                            |
| 1044       | In transit                     | Ask/wait for delivery; do not create an assessment |
| Unknown id | `order_not_found`              | Report missing order; do not fabricate a case      |

The fictional policy requires delivery within 0–30 days inclusive and a total of
at most USD 200. The function computes a result; it does not approve a refund.
The model instructions require successful lookups and a delivered order before
recording an assessment. They are not additional server-side value validation.
No external refund, shipment update, or message is performed by this example.

## Separate the evidence

```bash
pnpm test src/enterprise/combined-return.test.ts
node --import tsx scripts/enterprise-routing-eval.ts \
  --cases examples/enterprise/golden/combined-return-routing.yaml \
  --model openai/gpt-5.5 --repeat 3 --out /tmp/combined-return-routing.json
```

The focused regression uses the real local HTTP MCP server, knowledge retrieval,
ontology tools, SQLite writes, and governance audit. Its route is injected to
isolate tool execution. The routing evaluation separately calls a real model
against the combined example, financial work-map, incident work-map, and default
assistant; it does not invoke business tools or produce a user-facing answer.
Neither test alone proves a complete live chat. Inspect the live run trace to
confirm both routing and execution when using the example interactively.
