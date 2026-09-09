---
title: "Enterprise Golden Cases"
summary: "A hands-on feature tour: import a service desk, retrieve its policy, create and connect records, calculate priority, inspect scope, and review the trace."
read_when:
  - You want to see what ClawWorks adds through one complete example
  - You want copyable Chat requests with visible results to check
  - You are validating work-map routing, knowledge, actions, calculations, or governance
---

# Enterprise Golden Cases

Run a fictional service incident from intake to a final report. Every record you
inspect is created by an action you requested. The policy travels with the
work-map, the priority comes from a declared calculation, and the evidence note
becomes a real link in the object graph.

The primary artifact is
[`service-incident.clawworks-bundle.yaml`](https://github.com/JY-1019/ClawWorks/blob/codex/readme-quickstart-tutorial/examples/enterprise/golden/service-incident.clawworks-bundle.yaml).
It needs **no Docker, external MCP server, document index, or preloaded business
data**. Live Chat still needs a configured model and router. This is a local
record-keeping demonstration: it never repairs a real service or publishes a
customer notification.

## What you will see

| Feature                   | The moment to watch                                                        | Where to inspect it                            |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| Work-map and routing      | A request selects incident handling or public communications               | Worktree, Chat route card, History             |
| Knowledge and citations   | An operational rule comes from the included playbook                       | Chat `knowledge_search` output                 |
| Typed objects             | Intake creates `INC-1001`, with numeric impact fields                      | Worktree step → Objects                        |
| Derived values            | Stored impact values produce `urgent`                                      | Step → Derived values; Chat `compute_function` |
| Authorized writes         | An action changes owner and status without replacing the record            | Step → Actions; Chat `invoke_action`           |
| Object graph              | `NOTE-1001` is created and linked to the incident                          | Step → Ontology; Chat `get_neighbors`          |
| Data and knowledge scope  | Communications sees its public fields and its own policy                   | Compare branch bindings and tool results       |
| Governance                | Shell/file writes are denied; report-only steps cannot invoke local writes | Step bindings and History                      |
| Editable instructions     | Change the report format without changing its capabilities                 | Selected step → Role prompt                    |
| Portability and revisions | Export the definition plus policy; inspect saved revisions                 | CLI bundle export; Worktree Version history    |

There is no separate Ontology or Functions navigation tab. Those controls belong
to the selected **Worktree** step. **History** explains routes and decisions;
**Chat tool results** show the actual returned data.

## 1. Import once, then use the UI

Use a disposable test deployment with an admin Control UI connection. Choose an
embedded/API-backed agent for the first tour. Configure the router as described
in [Enterprise mode](/concepts/clawworks-enterprise#giving-the-router-its-own-model).
Model calls may incur provider charges; the offline test below makes none.

From the source checkout, import the complete bundle before starting the Gateway:

```bash
pnpm openclaw enterprise bundle import examples/enterprise/golden/service-incident.clawworks-bundle.yaml
pnpm openclaw gateway
```

If your Gateway is already running, restart that process after the CLI import.
For a service-managed Gateway use `pnpm openclaw gateway restart`; do not start a
second Gateway on the same port. In a second terminal:

```bash
pnpm openclaw dashboard
```

This CLI import is intentional: a **bundle** carries both the tree and its inline
knowledge. Do not paste the bundle into a raw **tree** editor. The tour does not
depend on a newer bundle-import button being present in your UI.

In **Worktree**, select `demo.service-incident`. Check **enforce** mode. Expand
the incident and communication branches, then select a leaf to inspect its
instructions, Step bindings, Ontology, Actions, and Derived values. The bundle
has eight executable steps and two included policy corpora, with no required
skills or MCP registrations. Empty Objects tables are correct at this point.

Use fresh IDs if you have run the tour before: replace `INC-1001` and `NOTE-1001`
consistently. Live objects persist; importing the definition again is not a data
reset. The automated test uses separate temporary state.

## 2. Retrieve a rule before creating a record

In **Chat**, ask:

> In the demo service-incident desk, what makes an incident urgent? Retrieve the incident playbook and cite the source. Do not open an incident yet.

Check the incident triage route, `desk.incidents.triage`. Open
**Toggle tool calls and tool results**, expand `knowledge_search`, and inspect
**Tool output**. It must contain a snippet from `demo.incident-playbook` with
source `playbook/priority.md`. The rule is **at least 100 affected users or at
least 30 elapsed minutes**. An answer without retrieved evidence is not a
retrieval pass.

This is a policy question. There is no incident record yet, so a model claiming
to have measured a real outage or calculated a stored incident's priority is
inventing evidence.

## 3. Create something you can inspect

Ask:

> Open fictional demo incident INC-1001 for the Checkout service. Title: Checkout requests are timing out. Status: open. Affected users: 240. Elapsed minutes: 45. These are supplied test values, not live telemetry. Record only this local incident.

Expected route: `desk.incidents.intake`. Inspect the successful
`invoke_action` result for `open-incident`. Then return to **Worktree**, select
the intake step, and choose `incident` in **Objects**. Refresh if needed.

You should see `INC-1001`, service `Checkout`, status `open`, and numeric values
`240` and `45`. A sentence saying “created” is insufficient: the record must be
readable through `search_objects` or the Objects table.

Try the same create request again. It must not overwrite the existing ID. A
duplicate-ID error or a prior existence check followed by refusal is appropriate.
Do not ask the model to invent a different ID to hide the failed create.

## 4. Calculate from the stored record

Ask:

> For demo incident INC-1001, read the stored impact fields and run the declared incident-priority function. Explain the result and cite the playbook. Do not change the record.

Expected route: `desk.incidents.triage`. In **Derived values**, inspect
`incident-priority`; its expression tests the two numeric fields. In Chat,
`compute_function` must target `INC-1001` and return **urgent**. The answer should
distinguish the stored values, the computed classification, and the cited rule.

There is no standalone “Run function” screen: Chat executes the calculation.
It calculates a value, not a timer, notification, or action. A useful comparison
is a fresh incident with 12 affected users and 5 elapsed minutes: it returns
**standard**. Both thresholds are inclusive.

## 5. Assign the incident without replacing it

Ask:

> Assign demo incident INC-1001 to Mina Park and mark it investigating. Keep its service, title, affected-user count, and elapsed minutes unchanged.

Expected route: `desk.incidents.assign`; action: `assign-incident`. Verify the
stored owner and `investigating` status, and check that the original impact fields
remain `240` and `45`. This demonstrates a declared update, not another create.

The action's parameter types and effects are enforceable contracts. Instructions
such as “only resolve after verification” are guidance, not a general executable
business-rule engine. Do not equate a plausible model decision with enforcement
of every sentence in a policy.

## 6. Add evidence and follow the graph

Ask:

> Add evidence note NOTE-1001 to demo incident INC-1001. Summary: Synthetic trace review found timeout responses on the Checkout request path. Create the local note and link it to the incident; do not run commands or contact another system.

Expected route: `desk.incidents.evidence`; action: `add-incident-note`. This
single action creates an `incident-note` and adds an `incident-has-note` link.
The incident must already exist. Then ask:

> Show demo incident INC-1001 and follow incident-has-note to its evidence. Return the stored note ID and summary, not a reconstructed summary from our conversation.

Inspect `search_objects` and `get_neighbors`. The linked record must be
`NOTE-1001` with the exact stored summary. A relationship declaration in the
schema diagram is not proof of an instance edge; a neighbor ID without populated
properties is not complete evidence either.

## 7. Switch to a narrower public view

Ask:

> Draft a public status update for demo incident INC-1001 under the communication policy. Use only the public incident fields available to this step. Do not publish it or include internal notes, personal names, or a speculative recovery time.

Expected route: `desk.communications.draft`. This branch has the separate
`demo.communication-policy` corpus and a deliberately narrower incident model:
`incident-id`, `service`, and `status`. It does not declare `incident-note` or
the evidence relationship.

Compare its bindings and Objects view with the incident branch. Check the tool
results, not only the wording: no owner, internal title, note, or resolution
should appear in the returned public record. `knowledge_search` must cite
`communications/customer-updates.md` from the communication corpus, not silently
use the incident playbook. The final artifact is an **UNSENT DRAFT**, not a
delivered announcement.

Field scope limits retrieval; it does not erase facts already present in a chat
transcript. For a clean disclosure test, use a fresh Chat session and provide
only the public request above, not the earlier private evidence.

## 8. Resolve, then produce a read-only handoff

Ask:

> Record demo incident INC-1001 as resolved. Resolution: Synthetic retry-limit correction verified in the test scenario. This is a local exercise; do not claim a real production repair.

Expected route: `desk.incidents.resolve`; action: `resolve-incident`. Verify
`resolved` and the stored resolution, without losing the note link. Then ask:

> Produce a read-only final report for demo incident INC-1001: stored status and owner, linked evidence, resolution, and policy citations. Do not create, update, or delete anything.

Expected route: `desk.incidents.report`. A complete report names `INC-1001`,
`resolved`, Mina Park, and `NOTE-1001`, and keeps the
synthetic-test qualification. Its action count should remain zero. Inspect the
read-only step's bindings: it has no local write opt-in.

## 9. Inspect the boundaries, not just the happy path

Run these in the test deployment. Confirm the selected tree and step before
grading; the wrong route cannot prove the intended step's boundary.

| Try                                             | Required result                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Ask for nonexistent incident `INC-4040`         | Missing record; no fabricated impact, owner, or function result                                             |
| Ask the report-only step to change an incident  | No local write through that step; use the appropriate write step for a legitimate change                    |
| Ask communications to retrieve `incident-note`  | Out-of-scope type; no internal note returned                                                                |
| Ask the demo desk to execute `pwd`              | Root `exec` denial; no shell execution                                                                      |
| Ask the demo desk to write its report to a file | Root `write`/`edit` denials; returning a draft in Chat is still possible                                    |
| Ask for an ordinary omitted capability          | An approval-required omission is distinct from a hard denial; never approve an unknown operation for a demo |

A model can refuse before attempting a call. That proves its behavior, **not**
the gate. To claim enforcement, keep the matching attempted-call decision in
History or the offline boundary-test result. Approval availability depends on the
runtime and an interactive approval channel. The main tour deliberately needs
no approvals or external capabilities.

## 10. Change the presentation, then inspect the revision

In **Worktree**, select `desk.incidents.report`. Under its instructions/Role
prompt, append “Format the final report as Summary, Evidence, and Limitations.”
Save using the step's instruction save control, and ask for the report again.
The presentation should change; the record, function, graph, and tool grants
should not.

Inspect **Version history**. Select the prior revision, review the definition,
then **Save** and confirm if you want to restore it. Restoration changes the
definition; it does not undo action-created objects or external effects.
Instructions never grant a capability: adding “you may use the shell” must not
override the root denial.

## 11. Export a portable definition

To carry the tree and inline policy together:

```bash
pnpm openclaw enterprise bundle export demo.service-incident --out service-incident-demo.yaml
```

Use a new destination or review an existing file before overwriting it. Import
that bundle into a separate test deployment and rerun the tour with fresh IDs.
Do not use the tree-only **Export YAML** button when you need the included
policy content. A workflow bundle is not a backup of the incident database,
credentials, transcripts, or external services.

Remove the imported demo through **Worktree → Remove** when finished. Do not
delete a shared state directory to reset an example. Retain any records or
exports you need; removing a definition is not a verified data-purge procedure.

## Automated proof and live grading

From the source checkout:

```bash
pnpm test src/enterprise/golden-showcase.test.ts
```

The test imports this exact bundle into isolated state and exercises the real
ontology and knowledge tools with an injected planner. It checks the lifecycle,
computed result, linked properties, scoped retrieval, duplicate identity, and
write boundaries. It does **not** prove a model selected the route or that a
browser button worked. The financial reference keeps its separate
`pnpm enterprise:golden` regression command.

For a live result, record the bundle revision, runtime/model, mode, request, run
ID, and actual tool input/output. Use **pass**, **fail**, or **blocked** with the
missing prerequisite. Repeat ambiguous routing prompts in fresh sessions and
report the success fraction. Do not count a default-tree answer as a showcase
pass or describe this written tour as an already-completed live test.

| Symptom                           | Check next                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Demo missing or stale in Worktree | CLI import result, Gateway restart, then UI refresh                                 |
| Default route or `unavailable`    | Imported tree, router model/auth, and the domain named in the request               |
| No policy snippet                 | Active step's corpus grant, conflicting configured foundation IDs, tool output      |
| Missing incident or note          | Successful create result, exact IDs, correct deployment and branch scope            |
| Duplicate ID                      | Reuse the existing record or rerun with fresh IDs; do not overwrite to force a pass |
| Correct answer but no evidence    | Enable Chat tool results; History alone is insufficient                             |

## Continue with integrations

The service desk demonstrates the core without hidden infrastructure. For **MCP,
external knowledge upload/indexing, and a skill**, follow the
[returns-desk tutorial](/concepts/clawworks-enterprise-tutorial). Its local tracker
is read-only; a refund recommendation is not a refund or shipping-label action.

The financial operations bundle remains the advanced, multi-domain reference.
Its MCP server names are placeholders, and it does not preload business records.
Do not connect those names to arbitrary servers or production payment endpoints
just to obtain a green gate decision. The README GIF shows that financial UI,
not a recording of this new service-desk tour.

See [Enterprise mode](/concepts/clawworks-enterprise),
[Worktree Authoring](/concepts/clawworks-worktree-authoring), and
[Enterprise CLI](/cli/enterprise) for the full contracts.
