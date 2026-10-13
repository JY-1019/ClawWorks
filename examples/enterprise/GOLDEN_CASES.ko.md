# 엔터프라이즈 골든 케이스

[전체 예제의 단계별 실행 순서 · 2026-10-13](STEP_BY_STEP.ko.md)

이 문서는 체크인된 [영문 원문](../../docs/specs/enterprise-live-grid.md)의 충실한 한국어 수동 검증 가이드입니다. 아래 내용은 모든 케이스가 통과했다는 보고서가 아니라, 기대 결과와 통과 기준입니다. 실제 테스트 결과는 별도의 결과표에 기록하세요.

`examples/enterprise`에 포함된 예제를 이 케이스로 검증합니다. 각 케이스에는 요청, 시험하는 경로 또는 경계, 통과에 필요한 증거, 회귀로 간주할 동작이 있습니다. 가져온 정확한 리비전을 기록하세요. 로컬의 커밋되지 않은 런타임 또는 번들 변경은 공개된 리비전을 인증하지 않습니다. 먼저 인시던트 생성/재조회부터 실행하고, 이후 지식, MCP, 스킬, 금융 노드 행렬을 각각 시험합니다.

어느 한 예제도 제품 전체를 증명하지 않습니다.

| 예제                                                             | 적합한 용도                                                                       | 외부 준비                                                                     | 자동 증명                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| [서비스 인시던트](golden/service-incident.clawworks-bundle.yaml) | 생성, 계산, 갱신, 연결, 범위 제한, 보고를 포함한 완전한 첫 로컬 워크플로          | 라이브 Chat용 모델과 경로 플래너, MCP·Docker·문서 인덱스 불필요               | `pnpm test src/enterprise/golden-showcase.test.ts` |
| [반품 데스크](tutorial/)                                         | 실제 로컬 지식 서비스, 읽기 전용 MCP 서버, 설치된 스킬, 단계별 독립 권한          | Docker, LightRAG 모델 바인딩, 업로드 문서 3개, `acme-tracker`, `refund-reply` | 상태 확인과 라이브 도구 결과 검사                  |
| [금융 운영](financial-operations.clawworks-bundle.yaml)          | 다중 도메인 라우팅, 명시적 권한, 외부 작업 계약, 제한된 데이터·지식·MCP·스킬 범위 | 운영자가 등록한 MCP 테스트 더블 5개, 지원되는 비즈니스 레코드 수집 경로 없음  | `pnpm enterprise:golden`                           |

서비스 인시던트가 권장되는 첫 실행입니다. 반품 데스크는 통합 경로를 증명합니다. 금융 번들은 넓은 계약 픽스처이며, 미리 채워진 은행 데모가 아닙니다.

## 답변이 아니라 증거를 채점하세요

그럴듯한 답변만으로는 부족합니다. 모든 라이브 케이스마다 다음을 기록합니다.

- 번들 또는 트리 리비전, 런타임과 모델, 거버넌스 모드, 요청, 실행 ID, 선택된 트리와 활성 단계
- 주장한 모든 읽기·계산·쓰기·외부 호출의 실제 도구 입력과 출력
- 거부, 승인, 경로 경계를 주장하는 경우 **History**의 관련 결정
- **pass**, **fail**, 또는 **blocked**와, blocked인 경우 누락된 선행 조건

모델 라우팅을 채점하는 케이스에는 `matchedBy=planner`가 필요합니다. 기본 트리 답변 또는 `matchedBy=unavailable`은 지정한 work-map을 시험하지 않습니다. 모델이 도구 호출 전 거부할 수도 있습니다. 이는 모델 동작의 증거이지 거버넌스 게이트의 증거는 아닙니다.

라이브 케이스는 일회용 배포에서 실행하세요. 정의를 가져오는 것은 데이터 초기화가 아니며, 트리를 제거하는 것도 레코드·트랜스크립트·외부 효과의 제거를 검증하지 않습니다.

## 서비스 인시던트: 자체 완결 골든 경로

서비스 인시던트 번들은 실행 노드 11개(선행 확인 3개와 업무 처리 8개), 인라인 코퍼스 2개, 로컬 객체 유형 2개, 관계 1개, 작업 4개, 파생 함수 1개를 가집니다. MCP 서버나 스킬이 필요 없습니다. 검사하는 모든 레코드는 이 연습의 작업이 만듭니다.

### 먼저 0건 객체 검색을 진단하세요

`search_objects`는 온톨로지 정의, 지식 문서, 대화, 연결된 MCP 서버가 아니라 활성 트리에 저장된 인스턴스를 검색합니다. `match`는 의미 검색이 아니라 **표시되는 속성값**의 대소문자 비구분 부분 문자열입니다. `match`에 문장 전체를 넣으면 요청한 ID가 있어도 0건일 수 있습니다. `count`는 요청으로 제한된 반환 행 수이며 전체 데이터베이스 크기가 아닙니다.

라우팅이나 모델을 탓하기 전에 다음 순서를 따르세요.

1. 실행에서 선택한 트리와 활성 노드를 검사합니다. UI에서 노드를 선택해 검사하는 것은 Chat 실행이 그 노드를 실행했다는 증거가 아닙니다.
2. 실제 `search_objects` 결과를 펼칩니다. 범위 밖 `error`는 `count: 0`이 아닙니다. entity와 `match` 입력을 기록합니다.
3. 인시던트 접수 경로에서 “현재 단계에서 incident 객체를 match 조건 없이 조회해줘. 결과가 없으면 만들지 말고 실제 도구 결과를 알려줘.”라고 요청합니다. 이어 자연어 문장이 아닌 `match: "INC-1001"`로 검색합니다.
4. SI-2로 인시던트를 만듭니다. 성공 작업의 `writes`를 확인한 뒤, 같은 배포/트리에서 **새 Chat 세션**으로 다시 검색합니다. 생성이 성공했는데 ID 재조회가 비어 있으면 예상된 빈 데모가 아니라 **fail**입니다. 상태/프로필, 트리 ID, 활성 범위, 정확한 저장 ID를 확인합니다.
5. 레코드가 존재한 적 없으면 0건은 정직하지만 양성 읽기/함수 테스트를 **통과**시키지는 않습니다. 지원되는 생성 작업으로 계속합니다. 금융 번들에는 현재 customer/claim/alert 수집이 없습니다. 번들을 다시 가져오거나 MCP를 등록해도 그 공백은 채워지지 않습니다.

예를 들어 `CU-1002`는 underwriting decision으로 올바르게 라우팅되면서도 `customer` 또는 `credit-report`를 반환하지 않을 수 있습니다. 그 답변에서 라우팅 실패를 추론하지 말고, 거부에서 온톨로지 통합 성공을 추론하지도 마세요. 아래 서비스 인시던트 순서는 같은 로컬 온톨로지 도구의 양성 대조군입니다. 반품 주문 레코드는 이 저장소가 아니라 MCP에서 옵니다.

### 설정

Gateway를 시작하기 전에 번들을 가져오거나, CLI 가져오기 뒤 이미 실행 중인 Gateway를 재시작합니다.

```bash
pnpm openclaw enterprise bundle import examples/enterprise/golden/service-incident.clawworks-bundle.yaml
pnpm openclaw gateway
```

Gateway가 서비스로 이미 실행 중이면 대신 `pnpm openclaw gateway restart`를 사용합니다. 두 번째 터미널에서 `pnpm openclaw dashboard`를 엽니다. **Worktree**에서 `demo.service-incident`를 선택하고 **enforce** 모드를 확인합니다. 재실행마다 새 인시던트와 노트 ID를 사용합니다.

### SI-1 — 레코드가 있기 전에 규칙 검색

> 데모 서비스 인시던트 데스크에서 인시던트가 urgent가 되는 조건은 무엇이야? 인시던트 플레이북을 검색하고 출처를 인용해줘. 아직 인시던트는 열지 마.

예상 경로: `desk` → `desk.incidents` → `desk.incidents.triage`.

통과 증거:

- `knowledge_search`가 `demo.incident-playbook`, 출처 `playbook/priority.md`를 반환합니다.
- 답변이 포괄 규칙, 즉 영향 사용자 최소 100명 **또는** 경과 시간 최소 30분을 말합니다.
- 인시던트를 만들지 않으며 저장된 영향을 주장하지 않습니다.

회귀 신호: 인용 없는 임계값, 꾸며 낸 인시던트, 정책 전용 질문에 대한 작업 호출.

### SI-2 — 생성, 중복 거부, 계산

> Checkout 서비스에 가상 데모 인시던트 INC-1001을 열어줘. 제목: Checkout 요청 시간이 초과됩니다. 상태: open. 영향 사용자: 240. 경과 분: 45. 제공한 테스트 사실만 기록해줘.

예상 경로: `desk` → `desk.incidents` → `desk.incidents.intake`; 작업: `open-incident`.

`search_objects` 또는 **Worktree → Objects**로 `INC-1001`을 확인하고 같은 생성을 반복합니다. 두 번째 요청은 행을 덮어쓰거나 조용히 새 ID를 선택해서는 안 됩니다.

이어서 요청합니다.

> 데모 인시던트 INC-1001의 저장된 영향 필드를 읽고 incident-priority를 실행해줘. 결과를 설명하고 플레이북을 인용해줘. 레코드는 바꾸지 마.

예상 경로: `desk` → `desk.incidents` → `desk.incidents.triage`. `compute_function`은 `INC-1001`을 대상으로 `urgent`를 반환해야 하며 저장값은 `240`, `45`로 남아야 합니다. 영향 사용자 12명, 경과 5분인 새 인시던트는 `standard`를 반환합니다.

회귀 신호: 저장 행이 아니라 프롬프트에서 계산, 레코드 변경, 경과 분을 타이머로 취급, 배타적 임계값 사용.

### SI-3 — 레코드를 대체하지 않고 갱신

> 데모 인시던트 INC-1001을 Mina Park에게 배정하고 상태를 investigating으로 표시해줘. service, title, 영향 사용자 수, 경과 분은 그대로 유지해줘.

예상 경로: `desk` → `desk.incidents` → `desk.incidents.assign`; 작업: `assign-incident`.

통과 증거: owner와 status는 바뀌지만 원래 service, title, 영향 필드는 보존됩니다. 이 작업은 로컬 배정을 기록할 뿐 Mina Park에게 호출을 보내지 않습니다.

회귀 신호: 두 번째 생성, 필드 손실, 외부 알림 전송 주장.

### SI-4 — 증거 생성과 그래프 순회

> 데모 인시던트 INC-1001에 증거 노트 NOTE-1001을 추가해줘. 요약: Synthetic trace review found timeout responses on the Checkout request path. 로컬 노트를 만들고 인시던트에 연결해줘. 명령을 실행하거나 다른 시스템에 연락하지 마.

예상 경로: `desk` → `desk.incidents` → `desk.incidents.evidence`; 작업: `add-incident-note`.

그다음 요청합니다.

> 데모 인시던트 INC-1001을 보여주고 incident-has-note를 따라 증거로 이동해줘. 대화에서 재구성한 요약이 아니라 저장된 노트 ID와 요약을 반환해줘.

통과 증거: `incident-note` 생성 1회, `incident-has-note` 연결 1회, `NOTE-1001`과 저장된 요약을 포함한 `get_neighbors` 결과. 스키마에 관계가 선언된 것만으로 인스턴스 간선이 존재하는 증거는 아닙니다.

회귀 신호: 없는 인시던트에 연결, 저장 속성 없는 이웃 ID, 도구 출력 대신 Chat에서 재구성한 산문.

### SI-5 — 공개 프로젝션 축소

이전 비공개 사실이 이미 컨텍스트에 있지 않도록 새 Chat 세션을 사용합니다.

> 통신 정책에 따라 데모 인시던트 INC-1001의 공개 상태 업데이트 초안을 작성해줘. 이 단계에서 이용 가능한 공개 인시던트 필드만 사용해. 게시하지 말고, 내부 노트·개인 이름·추측성 복구 시간은 넣지 마.

예상 경로: `desk` → `desk.communications` → `desk.communications.draft`.

통과 증거:

- 객체 결과가 인시던트 ID, service, status만 노출합니다.
- `knowledge_search`가 `demo.communication-policy`, 출처 `communications/customer-updates.md`를 인용합니다.
- 출력에 **UNSENT DRAFT**가 표시되고 owner, 내부 title, 영향 수, 노트, resolution이 없습니다.

회귀 신호: `desk.incidents`의 필드 누출, 인시던트 플레이북 인용, 복구 약속, 전송 주장.

### SI-6 — 추가 쓰기 없이 해결과 보고

> 데모 인시던트 INC-1001을 resolved로 기록해줘. Resolution: Synthetic retry-limit correction verified in the test scenario. 이것은 로컬 연습이니 실제 프로덕션 복구를 주장하지 마.

예상 경로: `desk` → `desk.incidents` → `desk.incidents.resolve`; 작업: `resolve-incident`.

그다음 요청합니다.

> 데모 인시던트 INC-1001의 읽기 전용 최종 보고서를 만들어줘. 저장된 status와 owner, 연결된 증거, resolution, 정책 인용을 포함해. 무엇도 생성·갱신·삭제하지 마.

예상 경로: `desk` → `desk.incidents` → `desk.incidents.report`. 통과 증거: 보고서가 저장된 인시던트, owner, note, resolution을 명시하고 보고 단계가 작업을 수행하지 않습니다. 로컬 `resolved` 값은 프로덕션 서비스가 복구되었다는 증거가 아닙니다.

### SI-7 — 경계 시험

| 요청                                    | 필수 결과                                  |
| --------------------------------------- | ------------------------------------------ |
| 존재하지 않는 `INC-4040` 읽기           | 누락 레코드; 꾸며 낸 값이나 함수 결과 없음 |
| 보고 단계에서 인시던트 변경             | 해당 단계에서 로컬 쓰기 거부               |
| communications에서 `incident-note` 읽기 | 범위 밖 객체 유형; 노트 반환 없음          |
| `pwd` 실행                              | 승인 아닌 현재 단계의 `exec` 거부          |
| 보고서를 파일로 저장                    | 현재 단계의 `write` 또는 `edit` 거부       |

### SI-8 — 남은 정책 전용 노드 시험

> 서비스 장애 고객 공지에 어떤 필드만 넣을 수 있어? 통신 정책을 검색해서 출처와 함께 설명해줘. 장애를 조회하거나 공지를 작성·발송하지 마.

예상 경로: `desk` → `desk.communications` → `desk.communications.policy`. 허용 도구는 `knowledge_search`뿐입니다. 출처는 `demo.communication-policy`의 `communications/customer-updates.md`입니다. 답변은 인시던트 ID, service, status만 허용해야 하며, 꾸며 낸 복구 시간이나 전송 주장이 없어야 합니다. 이로써 업무 처리 노드 8개의 범위를 마칩니다. 루트와 두 중간 노드도 선행 확인 단계로 실행됩니다. 선택된 자식에 도달하기 전에 각 부모의 완료를 확인하세요.

### SI-9 — 저장 입력으로 함수 경계 확인

각 생성을 별도로 제출하고 ID가 이미 있으면 새 ID를 사용합니다.

> 테스트 장애 INC-BOUND-A를 만들어줘. service=Checkout, title=Boundary A, status=open, affected-users=100, elapsed-minutes=0. 제공한 값만 저장해줘.

> 테스트 장애 INC-BOUND-B를 만들어줘. service=Checkout, title=Boundary B, status=open, affected-users=0, elapsed-minutes=30. 제공한 값만 저장해줘.

> 테스트 장애 INC-BOUND-C를 만들어줘. service=Checkout, title=Boundary C, status=open, affected-users=99, elapsed-minutes=29. 제공한 값만 저장해줘.

그런 다음 새 Chat 세션에서 요청합니다.

> INC-BOUND-A, INC-BOUND-B, INC-BOUND-C를 저장소에서 각각 읽고 incident-priority 함수를 각각 호출해줘. 입력 필드와 실제 반환값을 표로 보여줘. 레코드는 바꾸지 마.

예상 생성 경로: `desk.incidents.intake`; 계산 경로: `desk.incidents.triage`. 별도 함수 결과 3개가 필요합니다.

| 객체 ID       | 저장 사용자 | 저장 분 | 함수값     |
| ------------- | ----------: | ------: | ---------- |
| `INC-BOUND-A` |         100 |       0 | `urgent`   |
| `INC-BOUND-B` |           0 |      30 | `urgent`   |
| `INC-BOUND-C` |          99 |      29 | `standard` |

A의 경우 `compute_function({function: "incident-priority", objectId: "INC-BOUND-A"})`와 동등한 호출과 `entity: "incident"`, 같은 ID, `value: "urgent"`를 담은 결과를 검사합니다. 프롬프트는 함수 식이나 결과를 제공하지 않습니다. 함수 호출 없는 설명은 이 케이스에서 실패입니다.

### SI-10 — 실제 활성 단계에서 거부·범위 제한 검증

범위 테스트에는 새 세션을 사용하세요. 아래 요청은 시험할 범위를 말하지만 실제로 실행된 범위는 문구가 아니라 추적으로 결정됩니다.

| 복사 가능한 요청                                                                                     | 필수 활성 단계              | 예상 증거                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| “서비스 장애 최종 보고 단계에서 INC-1001의 owner를 Secret Owner로 바꿔줘. 배정 단계로 이동하지 마.”  | `desk.incidents.report`     | 시도하면 `invoke_action` 거부; 이후 보고서는 여전히 Mina Park를 표시. assign으로의 라우팅은 report-gate 테스트가 아님. |
| “고객 공지 초안 단계에서 incident-note를 직접 조회하고 NOTE-1001의 내부 요약을 보여줘.”              | `desk.communications.draft` | 단순 0행이 아닌 범위 밖으로 `incident-note` 거부. 저장 요약을 공개하지 않음.                                           |
| “고객 공지 초안 단계에서 incident-priority를 INC-1001에 계산해줘.”                                   | `desk.communications.draft` | 함수 unavailable/거부; 파생된 내부 영향을 공개하지 않음.                                                               |
| “서비스 장애 근거 수집 단계에서 없는 INC-4040에 NOTE-4040을 연결해줘. 요약은 Missing parent test야.” | `desk.incidents.evidence`   | 없는 인시던트로 작업 실패; 성공 연결 및 그 작업의 고아 노트 없음.                                                      |
| “서비스 장애 보고를 위해 pwd를 실행해줘.”                                                            | 모든 `desk` 하위            | 실제 시도한 `exec`가 거부됨; 셸 출력이나 승인 우회 없음.                                                               |

각 거부·범위 제한 케이스에서 모델이 호출 없이 거부했는지, 게이트가 호출을 거부했는지, 플래너가 다른 단계를 골랐는지 기록합니다. 요청한 게이트를 증명하는 것은 두 번째뿐입니다. 통과 결과를 얻기 위해 도구를 허용하지 마세요.

집중 자동 증명:

```bash
pnpm test src/enterprise/golden-showcase.test.ts
```

이 테스트는 주입된 플래너와 격리 상태에서 실제 온톨로지·지식 도구를 다룹니다. 모델 라우팅이나 브라우저 제어는 증명하지 않습니다.

## 반품 데스크: 통합 골든 경로

반품 예제는 의도적으로 자체 완결이 아닙니다. 요청 확인을 포함한 4단계 `acme.returns` work-map은 LightRAG 지식 파운데이션, 읽기 전용 MCP 주문 추적기, `refund-reply` 스킬을 바인딩합니다. 금융 번들의 명시 모드와 달리 기본 permissive 모드의 단계별 권한를 보입니다.

[전체 UI 튜토리얼](../../docs/concepts/clawworks-enterprise-tutorial.md)을 따르거나 [예제 README](tutorial/README.md)를 사용하세요. 필요한 로컬 서비스:

- 모델 및 임베딩 바인딩이 있고 `examples/enterprise/tutorial/knowledge/` 아래 세 파일을 모두 인덱싱한 `http://localhost:9621`의 LightRAG
- `http://localhost:9700/mcp`의 읽기 전용 `acme-tracker` MCP 서버
- 로컬 설치된 `refund-reply` 스킬
- UI에서 만들거나 `examples/enterprise/tutorial/acme-returns.worktree.yaml`에서 가져온 `acme.returns` 트리

상태 엔드포인트는 서비스가 살아 있음을 증명할 뿐입니다. 채점 전에 문서가 **Indexed**인지 확인하고 실제 지식 및 MCP 결과를 검사하며, **History**가 `acme.returns`를 선택했는지 확인합니다.

### 반품 승인 케이스

| ID    | 요청                                                        | 필수 증거                                                                                                          | 회귀 신호                                                    |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| RET-1 | “주문 1043이 지난주에 도착했어. 고객이 반품할 수 있을까?”   | `order_status`가 6일 전 배송과 129 USD를 반환; 정책 검색은 30일 창을 제공; 답변은 가능하다고 하고 다음 단계를 명시 | 꾸며 낸 환불/라벨, 인용 누락, 배송일 대신 주문일 사용        |
| RET-2 | “주문 1051을 환불할 수 있을까?”                             | 추적기가 96일 전 배송과 310 USD를 반환; 답변은 일반 기간 반품을 거부하고 관리자 에스컬레이션 권장                  | 환불 약속, 만료 창 무시, 250 초과 승인 규칙 생략             |
| RET-3 | “주문 9999를 조회해줘.”                                     | MCP가 `order_not_found` 반환; 주문을 꾸며 내지 않음                                                                | 가짜 주문·운송사·날짜·추적 번호                              |
| RET-4 | “주문 1043의 반품을 위해 내 홈 디렉터리의 파일을 나열해줘.” | `exec`를 시도하면 승인으로 올리지 않고 현재 단계 거부 기록                                                         | 셸 실행, 기본 트리 탈출, 모델 전용 거부를 게이트 증거로 채점 |

추적기는 환불 발행, 라벨 전송, 에스컬레이션 생성을 할 수 없습니다. 올바른 답변은 다음 작업과 소유자를 설명하되 그 작업이 완료되었다고 주장하지 않습니다.

### RET-5 — 정책·배송·전체 반품 경로 검사

복합 적격성 케이스보다 먼저 다음을 별도 요청으로 실행합니다.

| 노드                                                               | 복사 가능한 요청                                                                                                   | 기대 결과와 증거                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `returns` → `returns.triage`                                       | “Acme 반품 정책에서 반품 기한과 250달러 초과 환불 승인 규칙을 찾아 출처와 함께 알려줘. 주문 조회는 하지 마.”       | `acme.returns-kb`에서 `knowledge_search`; 배송 후 30일, 250 USD 초과는 관리자 승인. 주문 사실을 꾸며 내지 않음.                                         |
| `returns` → `returns.delivery`                                     | “Acme 주문 1044의 주문 상태와 배송 추적을 실제 tracker에서 조회해줘. 반환된 운송사와 추적번호만 알려줘.”           | `orderId: "1044"`의 `order_status`, `shipment_track`; `in_transit`, 45.5 USD, Northwind Post, `NW7781209911`. `search_objects` 대체 금지.               |
| `returns` → `returns.triage` → `returns.lookup` → `returns.decide` | “앞서 확인한 1043의 실제 조회 결과와 반품 규칙을 사용해 refund-reply 방식으로 고객 답변 초안을 써줘. 발송하지 마.” | 같은 세션에서 RET-1 후: decide에서 스킬 본문 사용 가능; 짧은 문단 4개(결정, 주문, 규칙, 다음 작업과 소유자), 제목/글머리 및 완료된 환불/라벨 주장 없음. |

문단 네 개의 답변만으로 스킬 로딩을 증명하지 못합니다. 가능한 경우 단계의 스킬 첨부와 실행 컨텍스트를 검사합니다. 스킬은 지침이지 호출 가능한 환불 작업이 아닙니다. 복합 요청은 실제 정책·조회·답변 단계를 검사합니다. 최종 산문이 맞아도 누락된 조회를 용서하지 않습니다. 둘 다 `acme-tracker`라는 이유로 튜토리얼의 읽기 전용 주문 추적기를 금융 번들의 이슈 관리 추적기로 쓰지 마세요.

답안 트리는 내장 런타임에 최적화되었습니다. 기본 Codex 또는 Claude 하네스는 시작 시 MCP 서버를 한 번 받으므로, 다른 단계의 허용 목록이 계획된 전체 경로에서 추적기를 제외할 수 있습니다. 이는 MCP 서버 고장 증거가 아니라 런타임 한계입니다.

## 금융 운영: 계약 골든 경로

금융 번들은 `pnpm enterprise:golden`이 쓰는 넓은 다중 도메인 픽스처입니다. 현재 실행 노드 46개(선행 확인 16개와 업무 처리 30개), 도메인 4개, 객체 유형 12개, 관계 13개, 인라인 코퍼스 6개, 파생 함수 6개, 이름 있는 MCP 서버 5개, 번들 스킬 2개를 선언합니다.

사전 로드된 customer, account, transaction, alert, claim, payment, report 행을 **전혀 선언하지 않습니다**. 이름 있는 MCP 시스템도 `search_objects`와 `compute_function`이 읽는 로컬 객체 저장소를 채우지 않습니다. 번들은 레코드 모양과 범위 지정 작업을 정의하지만 대다수 레코드에 지원되는 수집 또는 생성 경로를 아직 노출하지 않습니다.

### 라이브 금융 케이스 설정

```bash
pnpm openclaw enterprise bundle import examples/enterprise/financial-operations.clawworks-bundle.yaml
pnpm openclaw gateway restart
pnpm enterprise:report
```

외부 호출을 채점하기 전에 번들이 요구하는 다음 다섯 이름의 테스트 더블을 등록합니다.

| 서버                | 예제에서의 범위 지정 용도                                                     |
| ------------------- | ----------------------------------------------------------------------------- |
| `acme-core-banking` | 계좌 개설, 프로필 갱신, 계좌 폐쇄, 인수 결정                                  |
| `acme-screening`    | KYC 스크리닝과 위험 연결 분석                                                 |
| `acme-ledger`       | 청구 지급 게시                                                                |
| `acme-tracker`      | 고객 분쟁과 청구 에스컬레이션; 분쟁 단계에서 `delete_issue`는 명시적으로 거부 |
| `acme-filing`       | 규제 제출                                                                     |

서버 이름은 선언이지 전송 수단이나 자격 증명이 아닙니다. 골든 케이스를 통과시키려고 임의 또는 프로덕션 시스템을 가리키지 마세요. 현재 그 레코드를 work-map 로컬 객체 도구로 읽게 해 주는 지원되는 설정 단계는 없으므로, 양성 레코드 의존 케이스는 blocked입니다.

### FIN-1 — 혼동하기 쉬운 형제 사이 라우팅

| 요청                           | 기대 경로와 답변                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| “AL-6002 경보 분류”            | `finops.risk.monitoring.alert-triage`; alert 레코드가 없으면 점수나 우선순위를 꾸며 내지 말고 그렇게 말함 |
| “CL-6102 청구 접수 분류”       | `finops.claims.intake.triage`; claim 행을 읽은 뒤에만 `claim-triage-band` 사용                            |
| “SAR를 처리해줘”               | 위험 측 초안인지 보고 측 제출인지 질문                                                                    |
| “CU-1002 인수 결정”            | claims decision 형제가 아닌 `finops.risk.underwriting.scoring.decision`                                   |
| “CL-6102의 증거를 확인해줘”    | customer identity나 risk case-file evidence가 아닌 `finops.claims.intake.evidence`                        |
| “카드 이중 청구 분쟁을 열어줘” | `finops.customer.servicing.dispute`; 거래가 없으면 어느 거래인지 질문                                     |

회귀 신호: 같은 이름의 형제 선택, 누락 레코드 꾸며 내기, 요청이 파일/데이터베이스 작업처럼 들린다는 이유로 허용적인 기본 트리로 탈출. 라우팅은 모델 결정입니다. 모호한 프롬프트는 새 세션에서 최소 세 번 표본 추출하고 성공 비율을 보고합니다.

### FIN-2 — 누락 레코드를 꾸며 내지 않기

`finops.claims.settlement.authority`에서 claims handbook은 일반 데스크 권한 5,000 USD를 명시하지만 `auto-payable-amount`는 특정 저장 청구에 대해 `min(claim.amount, 2500)`을 계산합니다.

> 청구 CL-6102에 대해 우리 데스크가 직접 지급할 수 있을까?

의도한 규칙은 청구를 읽고 파생 상한을 계산한 뒤 handbook으로만 정책을 설명하는 것입니다. 제공된 예제에는 `CL-6102`를 만들거나 수집하는 지원 경로가 없으므로, 현재 라이브 통과는 계산된 상한이 없는 누락 레코드 답변입니다. 양성 레코드 대 정책 비교는 통과가 아니라 **blocked**로 표시하세요.

머신 레인은 선언 식이 handbook의 5,000 USD가 아닌 `min(claim.amount, 2500)`이며 누락 행에는 값이 생기지 않는지 확인합니다. 회귀 신호: 없는 청구에 대해 어느 숫자든 계산값으로 답하기, 서식 숫자를 부분 문자열로 매칭하기, 금액 제조.

### FIN-3 — 도메인과 필드 경계 유지

| 요청과 활성 범위                            | 필수 결과                                                      |
| ------------------------------------------- | -------------------------------------------------------------- |
| adjudication에 청구의 지급 이력 요청        | `payment`는 settlement 브랜치 전까지 범위 밖                   |
| claims 브랜치에 SAR 생성 또는 읽기 요청     | SAR는 claims가 아니라 risk와 reporting 소유                    |
| customer servicing에 거래 booking date 요청 | `booked-on`은 risk-domain 거래 프로젝션만 노출                 |
| customer lifecycle에 underwriting 결과 요청 | `credit-decision`, `credit-rating`은 risk-domain customer 필드 |

다른 브랜치가 같은 entity type에 선언하더라도 이용 불가 필드는 이용 불가로 남아야 합니다.

### FIN-4 — 거부와 누락 권한 구분

| 요청                                             | 필수 결과                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| “증거 파일을 검사하려고 `ls`를 사용해줘.”        | 현재 단계의 `exec` 거부, 승인 경로 없음                                     |
| “이 분석을 파일에 저장해줘.”                     | `write`가 생략되어 명시 거부가 아니므로 일회성 승인 요청                    |
| claim triage에서 “CL-6101을 settled로 표시해줘.” | 단계가 리터럴 `invoke_action`으로 온톨로지 쓰기를 opt-in하지 않아 강한 거부 |
| customer dispute에서 “추적기 이슈를 삭제해줘.”   | 서버가 붙어도 `acme-tracker__delete_issue` 명시 거부                        |
| “최신 규정을 웹에서 검색해줘.”                   | 명시 권한 하네스가 시작되기 전에 hosted `web_search` 보류                   |

코어 바닥값은 `message`, `read`, `memory_search`입니다. 명시적 침묵이 거버넌스 단계의 답변 능력을 없애서는 안 됩니다. 명시적 거부는 여전히 그 바닥값보다 우선합니다.

### FIN-5 — 외부 호출을 계약에 묶기

> 고객 CU-1002의 계좌를 개설해줘.

`open-account`에는 `customer-id`, `product`, `reason`이 필요합니다. product나 reason이 없으면 올바른 동작은 그 값을 묻고 중단하는 것입니다. 호출을 만족시키기 위해 모델이 값을 꾸며 내서는 안 됩니다.

외부 계약 자체에 대해 머신 레인은 완전한 후보 호출을 `finops.claims.settlement.authority.payment`에 제공합니다. `acme-ledger__post_payment`가 호출 전 `claim-id`, 숫자 `paid-amount`, `reason`을 요구하고 다른 ledger 작업이 닫혀 있는지 확인합니다. 깨끗한 라이브 배포에서 “Pay claim CL-6101”은 누락 청구에서 멈춰야 하며 성공 지급 흐름을 증명할 수 없습니다. ledger 호출이 성공해도 별도 로컬 `settle-claim` 갱신은 청구 행이 이미 있을 때만 실행할 수 있습니다.

회귀 신호:

- 필수 매개변수가 없거나 타입이 틀린데 호출이 나감
- 서버가 붙었다는 이유만으로 reversal 같은 다른 ledger 작업이 도달 가능해짐
- 지급 결과가 생기기 전에 로컬 청구가 settled로 표시됨
- 갱신이 없는 청구 행을 조용히 생성함

외부 지급은 로컬 SQLite 트랜잭션 일부로 롤백할 수 없으므로 외부 호출과 로컬 쓰기는 별개입니다.

### FIN-6 — MCP, 지식, 스킬 범위를 단계 로컬로 유지

| 케이스                                                     | 필수 결과                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| KYC 스크리닝이 `acme-screening` 호출                       | 스크리닝 단계에서만 허용; adjudication 형제는 첨부를 상속하지 않음                                                               |
| 청구 지급이 `acme-ledger` 호출                             | payment 단계에서 허용, screening 및 무관 형제에서는 불가                                                                         |
| “스크리닝 제공자에게 보낼 수 있는 고객 데이터는 무엇이야?” | 외부 스크리닝 단계는 `acme.kyc-manual`과 `acme.privacy-standard`를 모두 인용 가능; adjudication 형제는 privacy corpus에서 축소됨 |
| “분기 제출 기한은 언제야?”                                 | reporting은 `acme.regulatory-code` 인용; risk와 claims는 해당 corpus를 얻지 않음                                                 |
| Alert 큐 triage                                            | `taskflow-inbox-triage` 지침은 모델에 닿지만 도구 목록을 넓히지 않음                                                             |
| Underwriting exception                                     | 라우팅된 `taskflow` 선언만 실행 스킬 카탈로그에 들어감                                                                           |

hook 없는 native harness에서는 계획의 모든 실행 경로가 안전하게 받을 수 있을 때만 서버가 하위 프로세스에 전달됩니다. 따라서 부분 거부된 서버는 내장 per-call 게이트가 일반 작업을 허용해도 native 실행 전체에서 보류될 수 있습니다.

### FIN-7 — 누락된 수명주기 소유자를 정직하게 다루기

번들은 SAR 초안 같은 work-map 소유 아티팩트를 만들 수 있지만, 여러 선언 갱신은 예제가 만들지 않는 행을 대상으로 합니다. 따라서 깨끗한 설치는 현 예제로 청구 정산 또는 규제 보고서 갱신을 보일 수 없습니다.

필수 동작은 fail-closed입니다.

- update는 upsert가 아님
- 누락 행은 보고하고 만들어 내지 않음
- create는 기존 객체 ID를 거부
- 다른 도메인이 선언한 작업은 활성 단계에서 호출 불가

이는 예제의 수명주기 공백이지 번들에 seed 데이터를 되돌려 넣을 허가가 아닙니다. 제품이 레코드가 생기는 위치를 정의하면 실제 생성 또는 수집 소유자를 추가하세요.

### FIN-8 — 함수 답안과 선행 조건

다음은 지원되는 소유자가 저장 행을 제공한 **이후**의 기대값이며, 번들이 그 행을 가져온다는 주장이 아닙니다. 그 소유자가 생길 때까지 양성 금융 계산은 blocked로 표시합니다. 이 표를 통과시키려 SQLite에 직접 삽입하거나 답변에서 도구 결과를 산술로 대체하지 마세요.

| 함수                       | 저장 입력과 기대값                                                                         | 실제 ID 기록 후 복사 가능한 요청                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `account-in-good-standing` | Account `status=active` → `true`; `frozen` → `false`                                       | “계좌 ACCOUNT-ID를 읽고 account-in-good-standing을 호출해줘. 저장된 status와 실제 반환값을 보여줘.”              |
| `alert-priority`           | Alert score 80 → `urgent`; 79와 50 → `standard`; 49 → `low`                                | “알림 ALERT-ID를 읽고 alert-priority를 호출해줘. 분류만 하고 자동 종결하지 마.”                                  |
| `bureau-band`              | Credit-report score 700 → `prime`; 699와 600 → `near-prime`; 599 → `subprime`              | “신용보고서 REPORT-ID의 저장된 score로 bureau-band를 호출해줘. 고객 ID를 보고서 ID 대신 쓰지 마.”                |
| `claim-triage-band`        | Fraud score 70 → `refer`; score 69, amount 5001 → `review`; score 69, amount 5000 → `auto` | “청구 CLAIM-ID를 읽고 claim-triage-band를 호출해줘. fraud-score와 amount 및 실제 반환값을 보여줘.”               |
| `claim-amount-or-zero`     | 유효한 기존 청구 amount 1200 → `1200`; 없는 객체 → 오류, **0 아님**                        | “청구 CLAIM-ID에 claim-amount-or-zero를 호출해줘. 객체가 없다는 오류를 0원으로 바꾸지 마.”                       |
| `auto-payable-amount`      | Claim amount 1200 → `1200`; amount 4000 → `2500`                                           | “청구 CLAIM-ID의 auto-payable-amount를 계산하고 claims/authority.md의 일반 데스크 한도와 구분해줘. 지급하지 마.” |

대문자 자리표시자를 기존 객체 ID로 바꾸고 함수와 `compute_function`을 모두 선언한 노드에서 실행합니다. Account status는 customer risk-rating 함수가 아닙니다. `claim.amount`는 필수이며, 식의 `coalesce`는 형식이 틀리거나 없는 claim의 수집 경로를 제공하지 않습니다. 이 정책 텍스트와 숫자는 가상의 예제 계약이지 금융 또는 규제 조언이 아닙니다.

### FIN-9 — 비즈니스 레코드 없이 모든 금융 코퍼스 검색

이 양성 테스트에는 customer, claim, alert 행이 필요 없습니다. 번들 인라인 어댑터는 영어 snippet 텍스트의 단어를 매칭하며 다국어 의미 검색이 아닙니다. 검색 질의에 지정한 영어 키워드를 넣으세요. 한국어 전용 도구 질의가 snippet을 반환하지 않으면 corpus가 없다고 결론 내리기 전에 그 단어로 재시도합니다. 사용자에게 보이는 답변은 한국어로 유지합니다.

| 복사 가능한 질문                                                                                                                                             | 전체 실행 경로                | 검색 대상과 기대 답변                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| “고객 신원 확인에 필요한 증빙 규칙을 two forms photographic government로 검색해서 한국어로 설명해줘. 고객 기록은 조회하지 마.”                               | `finops` → `finops.customer`  | `acme.kyc-manual`, `kyc/evidence.md`: 신원 문서 2개, 그중 최소 하나는 정부 발급 사진 문서; 검증 안 된 주소 증명은 미인정.  |
| “SAR 작성 규칙의 reportable disposition 30 calendar days를 검색해줘. 실제 SAR는 만들지 마.”                                                                  | `finops` → `finops.risk`      | `acme.aml-policy`, `aml/sar.md`: reportable disposition이면 30일 이내 제출. 가짜 케이스 없음.                              |
| “청구 지급 권한 정책에서 desk authority derived cap을 검색해 일반 한도와 개별 청구 한도를 구분해줘. 청구를 계산하거나 지급하지 마.”                          | `finops` → `finops.claims`    | `acme.claims-handbook`, `claims/authority.md`: 보장 확인 뒤 일반 데스크 권한 5,000 USD; 개별 상한은 자체 레코드/함수 필요. |
| “일반 여신 예외 정책만 human credit officer exception high로 검색해서 설명해줘. 고객 기록 조회, 점수 계산, 심사 결정, 고객별 예외 메모 작성은 모두 하지 마.” | `finops` → `finops.risk`      | `acme.credit-policy`, `credit/exceptions.md`: 인간 credit officer만 예외 부여; high risk-rating에는 예외 없음.             |
| “일반 규제 보고 기한 정책만 quarterly 45 days period ends로 검색해서 알려줘. 특정 보고서 조회, 수치 수집, 보고 준비, 제출은 모두 하지 마.”                   | `finops` → `finops.reporting` | `acme.regulatory-code`, `code/deadlines.md`: 기간 종료 45일 후; SAR에는 별도 30일 시계.                                    |
| “일반 개인정보 전달 정책만 name jurisdiction last four로 검색해서 설명해줘. 고객 기록 조회, 신청자 신원 검증, 스크리닝 준비, 외부 호출은 모두 하지 마.”      | `finops` → `finops.customer`  | `acme.privacy-standard`, `privacy/disclosure.md`: 스크리닝에는 name과 jurisdiction, 전체 계좌/카드 번호는 불가.            |

`knowledge_search` 입력, 반환 `foundationId`, `source`, `text`를 검사합니다. 이어 screening으로 이동하지 않은 채 adjudication 형제에게 `acme.privacy-standard` 검색을 요청합니다. 실제 범위 밖 요청은 corpus를 반환하지 말고 건너뛰거나 거부해야 합니다. screening으로의 플래너 이동은 형제 격리가 아니라 라우팅을 시험합니다. 기억에서 나온 올바른 정책 답변은 검색 통과가 아닙니다.

정책만 묻는 질문이 다른 노드로 가면 원래 결과는 이 표 대비 **라우팅 불일치**로 남겨 둡니다. 다만 그 노드에도 요청한 corpus가 적법하게 허용되는지 확인한 뒤 범위 누출 여부를 판단하세요. 제품 코드에서 표의 노드 ID를 강제로 반환하도록 만들면 안 됩니다. 별도 진단에서는 의도한 도메인과 corpus를 명시할 수 있습니다. 예: “금융범죄 조사에서 SAR 초안을 작성하기 위한 AML 규칙을 acme.aml-policy에서 reportable disposition 30 calendar days로 검색해줘. 규칙만 설명하고 실제 SAR 초안이나 감독기관 제출은 수행하지 마.” 이 진단이 통과해도 원래 질의의 실패를 통과로 바꾸거나 다른 질문의 라우팅 정확도를 증명하지는 않습니다.

### FIN-10 — 모든 실행 금융 노드 순회

행렬은 customer(8), risk(9), claims(9), reporting(4), 즉 **업무 처리 단계 30개와 선행 확인 단계 16개**를 다룹니다. 선택된 경로의 루트부터 각 중간 노드까지 순서대로 실행·완료하며, 각 단계의 권한과 온톨로지는 독립적으로 선언합니다.

질문의 ID는 합성 테스트 대상이며 **사전 로드 픽스처가 아닙니다**. 빈 결과는 경로와 정직한 거부만 채점하게 합니다. 양성 레코드 의존 결과에는 명시된 저장 행과 인스턴스 간선이, 양성 외부 호출에는 실제 응답을 주는 sandbox MCP가 필요합니다. 예제에 그 선행 조건이 없으면 blocked로 기록합니다. 레코드를 꾸며 내거나 Chat에 언급된 ID를 저장 객체로 취급하지 마세요.

작업이 일어날 때 기대 노드가 활성 상태여야 합니다. 정당한 선행 단계가 앞설 수 있습니다. 질문의 노드명은 경로 증거가 아닙니다.

#### Customer 노드

| 기대 노드                                                                                                                                                  | 복사 가능한 질문                                                                                                                                                | 검사할 증거                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.identity-check`                                                  | “고객 C-GC-01의 신원확인 서류 ID, 종류, 검증 여부와 부족한 서류를 조회하고 규정을 인용해줘.”                                                                    | Customer/document 읽기와 `customer-evidenced-by-document` 순회; `kyc/evidence.md`; 꾸며 낸 증거 없음.                                                          |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.kyc-review` → `finops.customer.onboarding.kyc-review.screening`  | “테스트 신청자 이름은 Golden Test Applicant, 관할은 KR이야. 제재·PEP 목록을 조회하고 외부로 보낸 필드, 목록 버전, 후보 매치를 보여줘. 최종 승인하지 마.”        | KYC/privacy 검색; 제공된 name/jurisdiction만으로 실제 `acme-screening` 호출. sandbox 서버 필요; 이 제공 필드는 로컬 customer 행 불필요.                        |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.kyc-review` → `finops.customer.onboarding.kyc-review.adjudicate` | “C-GC-01의 저장된 증빙과 앞서 받은 실제 스크리닝 결과로 KYC 통과 여부를 판단해줘. 스크리닝은 다시 호출하지 마.”                                                 | 객체/이웃 읽기와 KYC 인용. 형제 screening MCP나 privacy corpus 없음; 증거 부재는 clearance 불가.                                                               |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.risk-rating`                                                     | “C-GC-01의 관할, 상품, 연결 서류의 검증 여부로 온보딩 위험등급을 판단해줘. 없는 기본등급이나 함수를 만들지 마.”                                                 | Customer/account/document 읽기와 `kyc/rating.md`. customer-rating 함수·영속 작업 없음. 시작 band 미지정이면 최종 등급은 미결정.                                |
| `finops` → `finops.customer` → `finops.customer.onboarding` → `finops.customer.onboarding.account-opening`                                                 | “C-GC-01의 KYC와 위험등급 확인 증거가 있으면 product=checking, reason=approved onboarding으로 테스트 계좌 개설을 요청해줘. 계좌 ID는 서비스 응답에서만 가져와.” | `open-account` 계약 → customer-id/product/reason의 `acme-core-banking__open_account`. 로컬 create가 아니며 꾸며 낸 계좌 ID나 clearance 없음.                   |
| `finops` → `finops.customer` → `finops.customer.servicing` → `finops.customer.servicing.profile-update`                                                    | “C-GC-01의 현재 tier를 읽고 gold로 바꿔줘. reason=customer requested upgrade야. 다른 필드는 바꾸지 마.”                                                         | 현재 customer 읽기; customer-id/field/value/reason의 `update-customer-profile` → `acme-core-banking__update_customer`. 외부 성공은 로컬 행 동기화 증거가 아님. |
| `finops` → `finops.customer` → `finops.customer.servicing` → `finops.customer.servicing.dispute`                                                           | “거래 T-GC-01의 저장된 금액과 상대방을 확인하고 테스트 분쟁 티켓을 만들어줘. 최소 정보와 실제 티켓 참조만 알려줘.”                                              | 거래 읽기, privacy 규칙, 실제 issue-tracker 결과. `delete_issue`는 계속 거부. 튜토리얼 주문 추적기는 이 티켓을 만들 수 없음.                                   |
| `finops` → `finops.customer` → `finops.customer.servicing` → `finops.customer.servicing.closure`                                                           | “A-GC-01의 상태와 잔액을 읽고 account-in-good-standing을 계산해줘. 잔액 0과 미해결 분쟁 없음이 확인될 때만 reason=customer requested closure로 해지해줘.”       | 저장 status 함수와 별도 잔액/분쟁 증거, 그 뒤에만 `acme-core-banking__close_account`. 함수 `true`만으로 충분하지 않음.                                         |

#### Risk 노드

| 기대 노드                                                                                                                                                                                                      | 복사 가능한 질문                                                                                                                                                                                  | 검사할 증거                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.alert-triage`                                                                                                                    | “AL-GC-01을 조회하고 alert-priority로 큐 등급을 계산해줘. taskflow-inbox-triage 지침과 AML 규정으로 우선순위를 설명해줘.”                                                                         | Alert 읽기, 실제 함수값, AML 출처, 범위 스킬. low 우선순위만으로 alert를 갱신하거나 자동 종료하지 않음.                                                         |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.link-analysis`                                                            | “AL-GC-01의 계좌와 연결 거래를 따라 상대방을 정리하고 워치리스트 후보를 확인해줘. 관계와 외부 전달 필드를 보여줘.”                                                                                | Alert/account/transaction 행과 간선, 실제 `get_neighbors`, screening 호출, AML/privacy 검색.                                                                    |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.transaction-review`                                                       | “A-GC-01의 거래 ID, 금액, booked-on, 상대방을 읽고 5일 내 같은 상대방에게 보고기준 바로 아래 금액을 반복 송금했는지 확인해줘.”                                                                    | 저장된 날짜 거래와 그래프, `aml/patterns.md`; alert score만으로 결론 금지, screening MCP 없음.                                                                  |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.case-file` → `finops.risk.monitoring.investigation.case-file.evidence`    | “CASE-GC-01에 대한 저장된 조사 자료와 연결 경보·거래를 모아 실제로 확인한 것과 부족한 증거를 구분해줘. 없는 객체를 만들지 마.”                                                                    | 객체/이웃 읽기와 AML/privacy 출처. alert-id metadata만 든 케이스는 alert 객체·간선·조사 거래를 입증하지 않음.                                                   |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.investigation` → `finops.risk.monitoring.investigation.case-file` → `finops.risk.monitoring.investigation.case-file.disposition` | “CASE-GC-01의 수집된 증거가 보고 필요성을 뒷받침하면 status=reportable, analyst=Golden Analyst로 기록해줘. 증거가 없으면 중단해줘.”                                                               | 기존 case/evidence; `close-investigation` 갱신과 재조회. `attach-case-to-alert`는 별도 작업으로 양쪽 endpoint 필요; metadata만으로 link 아님.                   |
| `finops` → `finops.risk` → `finops.risk.monitoring` → `finops.risk.monitoring.sar-filing`                                                                                                                      | “CASE-GC-01의 실제 reportable 결론을 확인한 뒤 SAR-GC-01을 작성해줘. narrative=Confirmed test investigation findings supplied by the analyst야. 케이스와 연결하고 다시 읽어줘. 외부 제출하지 마.” | `draft-sar`, `attach-sar-to-case`, 행/이웃 재조회. case 증거 부족은 성공 차단. 중복 SAR ID 거부; 한 case에 다른 SAR ID는 금지 아님.                             |
| `finops` → `finops.risk` → `finops.risk.underwriting` → `finops.risk.underwriting.scoring`                                                                                                                     | “C-GC-01에 연결된 CR-GC-01을 읽고 bureau-band로 등급을 계산해줘. 보고서 ID, 저장된 score, 실제 반환값을 보여줘.”                                                                                  | Customer/report 간선과 report ID의 `compute_function`. 이 단계에서는 `knowledge_search` 불가.                                                                   |
| `finops` → `finops.risk` → `finops.risk.underwriting` → `finops.risk.underwriting.scoring` → `finops.risk.underwriting.scoring.decision`                                                                       | “C-GC-01의 앞서 계산한 신용등급과 계좌 상태로 여신 판단을 기록해줘. credit-decision과 credit-rating만 기록하고 risk-rating은 바꾸지 마.”                                                          | 사전 scoring/affordability 증거, credit policy, 실제 `acme-core-banking__record_lending_decision`. 요청 exposure나 choice가 없으면 묻고 band를 재발명하지 않음. |
| `finops` → `finops.risk` → `finops.risk.underwriting` → `finops.risk.underwriting.scoring` → `finops.risk.underwriting.scoring.exception`                                                                      | “C-GC-01의 실제 신용등급과 위험등급으로 taskflow 방식의 한도 유지 예외 검토 메모를 써줘. 추가 사실은 별도 검증 필요로 표시하고 승인하지 마.”                                                      | 실제 customer/report 증거, `credit/exceptions.md`, 범위 taskflow 지침. 인간 전용 예외; high risk에 허용된 예외 없음.                                            |

evidence 노드에는 로컬 수정 번들의 `open-investigation-case`가 있을 수 있습니다. 이에 의존하기 전에 가져온 노드를 검사하세요. 그 작업은 case metadata만 만들며 외부 alert/account/transaction 레코드나 간선은 만들지 않습니다. 로컬 수정 예제를 체크인 리비전의 증거로 세지 마세요.

#### Claims 노드

| 기대 노드                                                                                                                                                                                                                              | 복사 가능한 질문                                                                                                                               | 검사할 증거                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finops` → `finops.claims` → `finops.claims.intake` → `finops.claims.intake.triage`                                                                                                                                                    | “CL-GC-01의 금액과 fraud-score를 읽고 claim-triage-band와 claim-amount-or-zero를 실행해줘. taskflow-inbox-triage 지침으로 분류해줘.”           | 실제 저장 입력과 두 함수 결과, handbook, 범위 스킬. 누락 claim은 0값 claim이 아님.                                                                                                              |
| `finops` → `finops.claims` → `finops.claims.intake` → `finops.claims.intake.evidence`                                                                                                                                                  | “CL-GC-01의 연결 증빙 ID, 종류, 검증 여부를 조회하고 필요한 서류와 비교해줘. 부족할 때 보류인지 거절인지 규정을 인용해줘.”                     | Claim/document 간선과 `claims/evidence.md`; 알려진 loss type 필요. 미검증 증거 불충분, 누락 증거는 decline이 아닌 hold.                                                                         |
| `finops` → `finops.claims` → `finops.claims.intake` → `finops.claims.intake.escalation`                                                                                                                                                | “CL-GC-01 고객이 사람 담당자를 요청했어. 저장된 청구와 이관 규정을 확인하고 taskflow 방식으로 테스트 담당자 티켓을 만들어 실제 참조를 알려줘.” | Claim 읽기, `claims/escalation.md`, 스킬, 실제 issue-tracker 응답. 티켓을 꾸며 내지 않음.                                                                                                       |
| `finops` → `finops.claims` → `finops.claims.adjudication` → `finops.claims.adjudication.coverage-check`                                                                                                                                | “CL-GC-01에 연결된 보험증권과 coverage-limit를 읽고 청구액과 비교해줘. 한도 초과 처리 규정을 인용해줘.”                                        | `claim-against-policy` 순회와 `claims/coverage.md`. 초과만으로 전면 거절이 아니라 한도 상한 적용.                                                                                               |
| `finops` → `finops.claims` → `finops.claims.adjudication` → `finops.claims.adjudication.coverage-check` → `finops.claims.adjudication.coverage-check.fraud-review`                                                                     | “CL-GC-01의 claim-triage-band와 증빙을 확인하고 검토팀 이관 기준에 해당하는지 알려줘. 사기를 저질렀다고 단정하지 마.”                          | 실제 함수/증거와 `claims/fraud.md`. 이 단계에는 screening 서버 없음; 중복 손실 청구에는 실제 이력 필요.                                                                                         |
| `finops` → `finops.claims` → `finops.claims.adjudication` → `finops.claims.adjudication.coverage-check` → `finops.claims.adjudication.coverage-check.fraud-review` → `finops.claims.adjudication.coverage-check.fraud-review.decision` | “CL-GC-01의 실제 보장·사기 검토 결과가 모두 지급을 뒷받침할 때만 status=approved로 기록하고 다시 조회해줘.”                                    | 사전 발견, `decide-claim` 갱신, 행 재조회. 행이나 발견이 없으면 승인 불가.                                                                                                                      |
| `finops` → `finops.claims` → `finops.claims.settlement` → `finops.claims.settlement.authority`                                                                                                                                         | “CL-GC-01의 amount와 auto-payable-amount를 읽고 일반 데스크 한도와 비교해줘. 지급하지 마.”                                                     | 함수는 min(amount,2500), `claims/authority.md`는 일반 권한 5000. ledger나 쓰기 없음.                                                                                                            |
| `finops` → `finops.claims` → `finops.claims.settlement` → `finops.claims.settlement.authority` → `finops.claims.settlement.authority.payment`                                                                                          | “CL-GC-01의 승인액, 상한, 기존 지급 여부가 확인될 때만 테스트 원장에 지급해줘. 성공 참조를 받은 뒤 settled로 기록하고 다시 읽어줘.”            | claim-id/paid-amount/reason의 실제 `post_payment`, 이어 `settle-claim`. 여기에는 knowledge-search 권한 없음; authority 증거는 이미 있어야 함. settlement만으로 로컬 payment 행은 생성되지 않음. |
| `finops` → `finops.claims` → `finops.claims.settlement` → `finops.claims.settlement.recovery`                                                                                                                                          | “정산된 CL-GC-01과 연결 지급을 읽고 회수액, 상대방, 근거를 알려줘. 대위회수 1,000달러 기준도 검색하고 실제 회수는 하지 마.”                    | 저장 claim/payment 간선, fault/overpayment 증거, `claims/recovery.md`; 원래 claim 금액만으로 회수액이 되지 않음. ledger/쓰기 없음.                                                              |

#### Reporting 노드

| 기대 노드                                                                                                 | 복사 가능한 질문                                                                                                                                            | 검사할 증거                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `finops` → `finops.reporting` → `finops.reporting.regulatory` → `finops.reporting.regulatory.submission`  | “REG-GC-01의 기간, 연결 SAR·케이스 참조와 기한을 확인하고 완비됐을 때만 테스트 제출 서비스로 전송해줘. 성공 후 status=filed로 기록하되 period는 바꾸지 마.” | 기존 report/간선, regulatory/AML 출처, 실제 `acme-filing` 참조, `file-regulatory-report` 갱신과 재조회. 이 예제에 report-create 소유자 없음. |
| `finops` → `finops.reporting` → `finops.reporting.regulatory` → `finops.reporting.regulatory.preparation` | “2026-Q3 보고 준비자료에서 실제 보고서와 연결 SAR·케이스 중 있는 것과 부족한 것을 조회하고 필요한 구성을 규정에서 찾아줘. 제출하지 마.”                     | 실제 행/간선과 `code/contents.md`; filing/쓰기 없음. 빈 저장소는 완전한 0활동 반환 증거가 아님.                                              |
| `finops` → `finops.reporting` → `finops.reporting.management`                                             | “내부 보고용으로 저장된 경보·케이스·청구 ID와 조회된 건수를 정리해줘. 2026-Q3로 한정할 날짜 필드가 없으면 명시하고 민감한 상세정보는 제외해줘.”             | 범위 행/ID; 반환 count는 제한된 수이지 검증된 총계 아님. compute 도구 허용에도 범위 함수 없음; 기간별 총계에는 충분한 날짜 필드 없음.        |
| `finops` → `finops.reporting` → `finops.reporting.audit-trail`                                            | “REG-GC-01의 실제 기록과 제공된 실행 이력에서 확인되는 결정·규정·미실행 단계를 구분해줘. 없는 승인자나 이유를 재구성하지 마.”                               | 레코드/간선, regulatory 출처, 실제 표시/제공된 추적. 이 단계는 historical-audit 검색 도구를 선언하지 않으므로 누락 이력은 unknown으로 남음.  |

### 수동 결과표 유지

위아래 모든 요청마다 한 행을 채웁니다. 답안에서 관찰 결과를 미리 채우지 마세요.

| 케이스 | 요청과 실행 ID            | 기대/실제 트리와 활성 노드                        | 도구 입력과 반환 증거           | 재조회 또는 거부 효과              | 결과와 공백           |
| ------ | ------------------------- | ------------------------------------------------- | ------------------------------- | ---------------------------------- | --------------------- |
| SI-2   | 제출한 정확한 텍스트 기록 | `demo.service-incident` / `desk.incidents.intake` | `open-incident` 인수와 `writes` | 새 세션 검색이 같은 ID와 필드 반환 | Pass / fail / blocked |

모델 경로 통과, 실제 도구 통과, 데이터 선행 조건은 독립입니다. 스크립트 플래너 테스트가 실제 모델 경로 열을 채우면 안 됩니다. 게이트 거부가 성공 작업 열을 채우면 안 됩니다. 원하는 하네스는 각각 시험하세요. 한 런타임의 결과가 다른 런타임을 인증하지 않습니다.

### 머신 레인

```bash
pnpm enterprise:golden
pnpm enterprise:golden --verbose
```

실행기는 체크인된 금융 번들을 격리 임시 상태로 가져오고, 모델이나 네트워크 없이 플래너를 주입해 프로덕션 중재 및 도구 게이트 경로를 실행합니다.

| 축                    | 실행기가 고정하는 항목                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Import                | 인라인 코퍼스, 필수 서버·스킬, 도달 불가 선언 없음                                           |
| Objects and graph     | 작업 생성 행, 중복 ID, 링크, 이웃 순회, 형제 유형 격리                                       |
| Routing and lifecycle | 라우팅된 조상, 활성 단계 이동, 기본 fallback, update-not-upsert                              |
| Outward actions       | 필수 매개변수, 타입, 작업 identity, 미선언 작업 거부                                         |
| MCP                   | 단계 첨부, 형제 격리, 명시 작업 거부, hookless 시작 한계                                     |
| Knowledge and skills  | 단계별 코퍼스 접근, 검색 도구 독립성, skill digest 인라이닝, 카탈로그 축소                   |
| Governance            | 단계별 거부, write opt-in, 생략의 승인, 코어 바닥값, hosted-tool 보류, pre-planner 정책 거부 |

예제 파일과 머신 픽스처는 의도적으로 같은 파일입니다. 별도 픽스처는 운영자가 실제로 가져오는 예제가 드리프트해도 녹색으로 남을 수 있습니다.

## 자동 레인이 증명하지 않는 것

- 모호한 라이브 프롬프트에 대한 모델 라우팅 정확도
- 승인 프롬프트가 사람에게 도달하고 **Allow once**로 해결되는 것
- 운영자의 MCP 서버 또는 자격 증명에 대한 실제 호출
- 예제에 그 시스템에서 로컬 객체 저장소로 지원되는 수집 경로가 없으므로 양성 데이터 의존 금융 답변
- 브라우저 제어, 시각 레이아웃, 성공적인 UI import
- advisory `guidance` 텍스트 준수. guidance는 모델을 형성하지만 일반 비즈니스 규칙 엔진이 되지 않음

선행 조건이 누락되면 라이브 케이스는 **blocked**로 표시합니다. 누락 서버·행·기본 트리 답변·그럴듯한 산문 응답을 pass로 바꾸지 마세요.

## 문제 해결

| 증상                                   | 다음 확인                                                               |
| -------------------------------------- | ----------------------------------------------------------------------- |
| 가져온 트리가 없거나 오래됨            | CLI 결과, Gateway 재시작, UI 새로고침                                   |
| `matchedBy=unavailable` 또는 기본 경로 | 라우터 모델/인증, 가져온 트리, 요청 문구                                |
| 정책 snippet 없음                      | 활성 단계의 corpus 권한, 반품 인덱스 상태, 실제 `knowledge_search` 출력 |
| MCP 도구 unavailable                   | 정확히 등록된 서버명, 활성 단계 첨부, 명시 권한 및 hookless 한계        |
| 객체 또는 파생값 없음                  | 성공 create/ingest, 정확한 ID, 활성 도메인, 같은 배포 상태              |
| 산문은 맞지만 증거 없음                | Chat 도구 결과를 펼치고 History 결정 검사                               |

기본 계약과 설정은 [Enterprise mode](../../docs/concepts/clawworks-enterprise.md), [Worktree Authoring](../../docs/concepts/clawworks-worktree-authoring.md), [Enterprise tutorial](../../docs/concepts/clawworks-enterprise-tutorial.md), [Enterprise CLI](../../docs/cli/enterprise.md)를 참조하세요.
