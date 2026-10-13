# 모든 예제를 단계별로 실행하기

갱신: **2026-10-13**. 아래 표는 현재 파일에서 선택한 **끝 지점까지의 전체 실행 순서**입니다. 각 화살표는 부모의 작업과 `complete_step`을 마친 뒤 자식에 진입한다는 뜻입니다. 중간 노드도 실행합니다. 표에서 한 행을 고르면 그 행의 경로만 실행하며, 아래 행이나 자식까지 자동으로 실행하지 않습니다.

여러 끝 지점을 선택하면 공통 선행 단계는 한 번만 실행하고 선택된 단계는 YAML 정의 순서로 진행합니다. 도구·MCP·지식·온톨로지 권한은 현재 노드의 선언을 사용합니다. 스킬 본문은 선택 경로 전체에 실행 단위로 제공되며 보안 격리 수단이 아닙니다. 단계 완료는 입력과 결과를 확인한 후 기록하며, 필요한 데이터가 없으면 성공으로 간주하지 않습니다.

## 공통 3단계 뒤 2단계씩 분기하는 실행 검증 · 2026-10-13

[공통 경로 검증 가이드](shared-prefix/README.ko.md)에서 실제 모델 라우팅, MCP·지식·온톨로지 호출과 스킬 적용을 재현합니다. 환불/교환 각각 5단계, 두 분기 동시 요청 7단계, 중간 종료와 조회 실패를 검증합니다.

## 먼저 선택할 예제

- 반품 상담: `returns` → `returns.triage` → `returns.lookup` → `returns.decide`. 배송만 확인할 때는 `returns` → `returns.delivery`입니다.
- 서비스 장애: `desk`에서 요청을 확인하고 `desk.incidents`에서 생성 입력 또는 기존 기록을 확인한 뒤 선택한 작업을 실행합니다. 기존 기록의 보고·배정에 생성 단계를 끼워 넣지 않습니다.
- 금융: 점수 → 심사, 보장 → 사기 검토 → 판단, 권한 → 지급은 실제 선행 단계 체인입니다. 사건 생성과 기존 사건 처분, 보고 준비와 이미 준비된 보고서 제출은 별도 경로입니다. 둘 다 요청하면 준비가 제출보다 먼저 실행됩니다.
- 깊은 복합 반품: 요청 → 주문 문맥 → 반품 범위 → 사례 식별자 확인 후 마지막 한 단계에서 MCP·지식검색·객체검색·원자 작업·계산·관계 조회를 수행합니다.

새 YAML을 다시 가져오고 새 채팅에서 시험하세요. 금융 v2.1.0의 심사·사기 검토·지급 후속 노드 ID도 새 단계 경로에 맞게 바뀌었습니다. 과거 실행 ID를 새 경로로 사용하지 마세요. 이전 저장 정의는 파일 변경만으로 자동 갱신되지 않습니다. CLI import 뒤에는 Gateway를 재시작합니다. 각 설치 조건과 실제 질의는 아래 링크에 있습니다. 금융의 실제 데이터와 외부 MCP는 별도 준비가 필요하며, 예제 등록만으로 생성되지 않습니다.

## 반품 상담 · 5개 실행 노드

정의: [acme-returns.worktree.yaml](tutorial/acme-returns.worktree.yaml) · 버전 `1.1.0`

| 끝 지점까지 실행할 순서                                            | 해당 단계의 결과                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `returns`                                                          | Confirmed scope, known inputs, and any unresolved prerequisite.                   |
| `returns` → `returns.triage`                                       | Find the handbook rule that applies to this request.                              |
| `returns` → `returns.triage` → `returns.lookup`                    | After reading the policy, fetch order and shipment facts for a return assessment. |
| `returns` → `returns.triage` → `returns.lookup` → `returns.decide` | The decision, the rule it rests on, and the order id.                             |
| `returns` → `returns.delivery`                                     | Actual order status, shipment facts, or the tracker's not-found result.           |

## 서비스 장애 · 11개 실행 노드

정의: [service-incident.clawworks-bundle.yaml](golden/service-incident.clawworks-bundle.yaml) · 버전 `1.1.0`

| 끝 지점까지 실행할 순서                                       | 해당 단계의 결과                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `desk`                                                        | Requested incident operation, supplied ids, and excluded changes or messages. |
| `desk` → `desk.incidents`                                     | Creation inputs, verified existing incident, or a policy-only question.       |
| `desk` → `desk.incidents` → `desk.incidents.intake`           | The created incident id and the supplied facts, not a repair claim.           |
| `desk` → `desk.incidents` → `desk.incidents.triage`           | The function's returned value, stored inputs, and playbook citation.          |
| `desk` → `desk.incidents` → `desk.incidents.assign`           | Stored owner and status, with an explicit local-only qualification.           |
| `desk` → `desk.incidents` → `desk.incidents.evidence`         | One note creation, one graph link, and the persisted neighbor properties.     |
| `desk` → `desk.incidents` → `desk.incidents.resolve`          | Persisted status and resolution, without claiming external verification.      |
| `desk` → `desk.incidents` → `desk.incidents.report`           | A read-only incident summary with actual evidence and clear unknowns.         |
| `desk` → `desk.communications`                                | Policy-only scope or verified public incident fields for an unsent draft.     |
| `desk` → `desk.communications` → `desk.communications.policy` | The customer-update rule and its actual source citation.                      |
| `desk` → `desk.communications` → `desk.communications.draft`  | An unsent draft based only on public fields, plus its policy citation.        |

## 금융 운영 · 46개 실행 노드

정의: [financial-operations.clawworks-bundle.yaml](financial-operations.clawworks-bundle.yaml) · 버전 `2.1.0`

| 끝 지점까지 실행할 순서                                                                                                                                                                                                                | 해당 단계의 결과                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `finops`                                                                                                                                                                                                                               | Requested operation, supplied ids, and excluded writes or external calls.                                        |
| `finops` → `finops.customer`                                                                                                                                                                                                           | Sourced KYC/disclosure rule, or verified customer/account target and requested operation.                        |
| `finops` → `finops.customer` → `finops.customer.onboarding`                                                                                                                                                                            | Applicant id, available identity/KYC/risk evidence, and any missing prerequisites.                               |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.identity-check`                                                                                                                              | Which documents are held, which are verified, and what is still missing.                                         |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.kyc-review`                                                                                                                                  | Verified applicant and minimal screening inputs, or existing screening evidence.                                 |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.kyc-review` → `finops.customer.onboarding.kyc-review.screening`                                                                              | The screening verdict, the list version, and what was sent.                                                      |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.kyc-review` → `finops.customer.onboarding.kyc-review.adjudicate`                                                                             | Cleared or refused, naming the manual section that decided it.                                                   |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.risk-rating`                                                                                                                                 | A rating band and the factors that produced it.                                                                  |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.account-opening`                                                                                                                             | The new account id, or the reason it was not opened.                                                             |
| `finops` → `finops.customer` → `finops.customer.servicing`                                                                                                                                                                             | Existing target record, requested operation, and authorized change fields.                                       |
| `finops` → `finops.customer` → `finops.customer.servicing` → `finops.customer.servicing.profile-update`                                                                                                                                | What changed, on which customer id.                                                                              |
| `finops` → `finops.customer` → `finops.customer.servicing` → `finops.customer.servicing.dispute`                                                                                                                                       | The dispute outcome, or the tracker reference it was filed under.                                                |
| `finops` → `finops.customer` → `finops.customer.servicing` → `finops.customer.servicing.closure`                                                                                                                                       | The account id and its new status.                                                                               |
| `finops` → `finops.risk`                                                                                                                                                                                                               | Sourced policy answer, or risk task, record ids, and analysis/write boundary.                                    |
| `finops` → `finops.risk` → `finops.risk.monitoring`                                                                                                                                                                                    | Verified existing monitoring target, or supplied inputs for a new local case; any evidence gaps remain explicit. |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.alert-triage`                                                                                                                                            | The alerts worth working, banded, with the rule each fired on.                                                   |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation`                                                                                                                                           | Investigation target, available evidence, and selected analysis scope.                                           |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.link-analysis`                                                                                    | The counterparty map, and which names the watchlists returned.                                                   |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.transaction-review`                                                                               | The transactions that matter and the policy pattern they match.                                                  |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.case-file`                                                                                        | Fresh-case inputs or verified existing-case evidence for disposition.                                            |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.case-file` → `finops.risk.monitoring.investigation.case-file.evidence`                            | The case id, its supplied evidence metadata, and the records it rests on.                                        |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.case-file` → `finops.risk.monitoring.investigation.case-file.disposition`                         | The case id, its disposition, and whether a SAR follows.                                                         |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.sar-filing`                                                                                                                                              | The SAR id and the policy trigger that required it.                                                              |
| `finops` → `finops.risk` → `finops.risk.underwriting`                                                                                                                                                                                  | Applicant id, actual report id, and stored score for scoring.                                                    |
| `finops` → `finops.risk` → `finops.risk.underwriting` → `finops.risk.underwriting.scoring`                                                                                                                                             | The bureau score, its band, and the report id it came from.                                                      |
| `finops` → `finops.risk` → `finops.risk.underwriting` → `finops.risk.underwriting.scoring` → `finops.risk.underwriting.scoring.decision`                                                                                               | The decision, the lending band stored, and what drove it.                                                        |
| `finops` → `finops.risk` → `finops.risk.underwriting` → `finops.risk.underwriting.scoring` → `finops.risk.underwriting.scoring.exception`                                                                                              | A short exception memo naming the customer, the band, and the ask.                                               |
| `finops` → `finops.claims`                                                                                                                                                                                                             | Sourced claims-policy answer, or claim/policy ids, availability, and requested operation.                        |
| `finops` → `finops.claims` → `finops.claims.intake`                                                                                                                                                                                    | Known claim facts, evidence availability, and requested intake operation.                                        |
| `finops` → `finops.claims` → `finops.claims.intake` → `finops.claims.intake.triage`                                                                                                                                                    | The claim id, its band, and what put it there.                                                                   |
| `finops` → `finops.claims` → `finops.claims.intake` → `finops.claims.intake.evidence`                                                                                                                                                  | The documents held, verified or not, and what is still missing.                                                  |
| `finops` → `finops.claims` → `finops.claims.intake` → `finops.claims.intake.escalation`                                                                                                                                                | A handoff note naming the claim, the rule that forced it, and the tracker reference.                             |
| `finops` → `finops.claims` → `finops.claims.adjudication`                                                                                                                                                                              | Existing claim/policy inputs and any unresolved adjudication prerequisite.                                       |
| `finops` → `finops.claims` → `finops.claims.adjudication` → `finops.claims.adjudication.coverage-check`                                                                                                                                | Whether the loss is covered, with the policy id and the limit.                                                   |
| `finops` → `finops.claims` → `finops.claims.adjudication` → `finops.claims.adjudication.coverage-check` → `finops.claims.adjudication.coverage-check.fraud-review`                                                                     | The band, the indicators behind it, and whether it is referred.                                                  |
| `finops` → `finops.claims` → `finops.claims.adjudication` → `finops.claims.adjudication.coverage-check` → `finops.claims.adjudication.coverage-check.fraud-review` → `finops.claims.adjudication.coverage-check.fraud-review.decision` | The claim id, the decision, and the handbook section behind it.                                                  |
| `finops` → `finops.claims` → `finops.claims.settlement`                                                                                                                                                                                | Claim status, requested amount, and requested settlement operation.                                              |
| `finops` → `finops.claims` → `finops.claims.settlement` → `finops.claims.settlement.authority`                                                                                                                                         | Whether the desk may pay it, the cap that applied, and where each number came from.                              |
| `finops` → `finops.claims` → `finops.claims.settlement` → `finops.claims.settlement.authority` → `finops.claims.settlement.authority.payment`                                                                                          | The payment id, the amount, and the claim it settled.                                                            |
| `finops` → `finops.claims` → `finops.claims.settlement` → `finops.claims.settlement.recovery`                                                                                                                                          | What is recoverable, from whom, and under which handbook rule.                                                   |
| `finops` → `finops.reporting`                                                                                                                                                                                                          | Sourced reporting-rule answer, or report scope, period/id, audience, and filing intent.                          |
| `finops` → `finops.reporting` → `finops.reporting.regulatory`                                                                                                                                                                          | Reporting inputs or verified completed filing artifact and submission authorization.                             |
| `finops` → `finops.reporting` → `finops.reporting.regulatory` → `finops.reporting.regulatory.preparation`                                                                                                                              | The return's contents for the period, and what is still outstanding.                                             |
| `finops` → `finops.reporting` → `finops.reporting.regulatory` → `finops.reporting.regulatory.submission`                                                                                                                               | The filing reference, the period it covers, and the deadline it met.                                             |
| `finops` → `finops.reporting` → `finops.reporting.management`                                                                                                                                                                          | A short internal summary with the counts and the ids behind them.                                                |
| `finops` → `finops.reporting` → `finops.reporting.audit-trail`                                                                                                                                                                         | The record, its recorded decisions, and the rule each cited.                                                     |

## 깊은 복합 반품 · 11개 실행 노드

정의: [combined-return.clawworks-bundle.yaml](golden/combined-return.clawworks-bundle.yaml) · 버전 `1.1.0`

| 끝 지점까지 실행할 순서                                                                                                                           | 해당 단계의 결과                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations`                                                                                                                                      | Requested customer operation and excluded external actions.                                                                                           |
| `operations` → `operations.accounts`                                                                                                              | Explain account support options; no order assessment.                                                                                                 |
| `operations` → `operations.orders`                                                                                                                | Supplied order id or an explicitly policy-only request.                                                                                               |
| `operations` → `operations.orders` → `operations.orders.delivery`                                                                                 | Read shipment scans only; no return eligibility assessment.                                                                                           |
| `operations` → `operations.orders` → `operations.orders.returns`                                                                                  | Return task and whether local assessment records are requested.                                                                                       |
| `operations` → `operations.orders` → `operations.orders.returns` → `operations.orders.returns.policy`                                             | Policy-only questions; no order lookup or case creation.                                                                                              |
| `operations` → `operations.orders` → `operations.orders.returns` → `operations.orders.returns.cases`                                              | Supplied assessment identifiers, or a read-only manual-review request.                                                                                |
| `operations` → `operations.orders` → `operations.orders.returns` → `operations.orders.returns.cases` → `operations.orders.returns.cases.assess`   | Order facts, cited policy, computed eligibility, case id, and linked evidence. This is a local assessment; it does not authorize or execute a refund. |
| `operations` → `operations.orders` → `operations.orders.returns` → `operations.orders.returns.cases` → `operations.orders.returns.cases.escalate` | Explain escalation for exceptional returns; never create an assessment.                                                                               |
| `operations` → `operations.orders` → `operations.orders.billing`                                                                                  | Explain billing support; no return eligibility assessment.                                                                                            |
| `operations` → `operations.catalog`                                                                                                               | Product information requests; no order lookup or return assessment.                                                                                   |

## 질의와 검증

- [한국어 골든 사례](GOLDEN_CASES.ko.md): 장애 생성·조회, 금융 각 업무의 실제 질의와 기대 증거.
- [확장 수동 행렬](golden/MANUAL_MATRIX.ko.md): 장애·권한·반품 경계 조건.
- [라우팅 23개 사례](golden/routing-cases.yaml): 사전에 고정한 전체 단계 기대값. [실행 방법](golden/ROUTING.ko.md).
- [복합 반품 5개 라우팅 사례](golden/combined-return-routing.yaml)와 [도구 실행 방법](golden/COMBINED_RETURN.md).
- [반품 설치](tutorial/README.md)와 [LightRAG 12개 검사](tutorial/LIGHTRAG.ko.md).

```bash
pnpm test src/enterprise/examples.test.ts src/enterprise/golden-showcase.test.ts src/enterprise/combined-return.test.ts
pnpm enterprise:golden
```

위 자동 검사는 실제 예제 정의와 도구·단계 전환을 검사하지만 모델 판단은 주입합니다. 실제 모델 라우팅은 별도 실행하며, 라우팅 결과만으로 실제 업무 도구와 최종 답변까지 통과했다고 판단하지 않습니다. 네이티브 MCP 노출은 선택된 모든 단계의 공통 허용 범위로 제한되므로, 일부 단계만 MCP를 연결한 예제는 embedded per-call 런타임에서 실행하세요.
