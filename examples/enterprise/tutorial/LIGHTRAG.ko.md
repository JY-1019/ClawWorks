# LightRAG 예제: 정책 색인부터 노드별 검색 검증까지

기존 [로컬 스택](README.md)의 LightRAG와 정책 문서 3개를 그대로 사용합니다. 새 검색 서버나 가짜 검색 응답은 만들지 않습니다. 아래 LR01–LR12는 **기대 결과**이며 실행 통과 보고서가 아닙니다. 한국어 보조 가이드이며 설치 흐름의 영문 기준은 [Enterprise tutorial](../../../docs/concepts/clawworks-enterprise-tutorial.md)입니다.

## 1. LightRAG만 시작하기

Docker daemon과 LightRAG용 LLM·임베딩 API 연결이 필요합니다. 로컬 모델은 다운로드하지 않습니다. ChatGPT·Claude 구독이나 Chat 모델 로그인이 API 자격 증명을 제공하지는 않습니다. [`.env.example`](.env.example)을 복사하고 사용자가 자신의 API 키를 입력하세요. API 사용에는 별도 비용이 발생하며 업로드한 정책 문서 내용이 해당 제공업체로 전송될 수 있습니다. 실제 키를 문서·채팅·Git에 넣지 마세요.

`examples/enterprise/tutorial` 디렉터리에서 실행합니다. `.env`가 이미 있으면 덮어쓰지 말고 필요한 값만 확인하세요.

```bash
cp -n .env.example .env
chmod 600 .env
# 편집기로 .env를 열고 아래 두 API 키를 모두 입력한 뒤:
docker compose up -d lightrag
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:9621/health
```

이 파일은 저장소 루트가 아닌 `examples/enterprise/tutorial/.env`이며 Git에서 제외됩니다. 이 예제의 LightRAG 컨테이너만 모델 키를 읽고 Gateway·MCP 설정은 바꾸지 않습니다.

| 설정                                                         | 입력 내용                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `LLM_BINDING_API_KEY`                                        | 문서 색인·답변용 모델 API 키                                  |
| `EMBEDDING_BINDING_API_KEY`                                  | 임베딩 API 키. 같은 계정이면 위와 같은 키를 두 칸에 입력 가능 |
| `LLM_BINDING_HOST`, `LLM_MODEL`                              | 기본 OpenAI API 또는 호환 API의 주소·모델                     |
| `EMBEDDING_BINDING_HOST`, `EMBEDDING_MODEL`, `EMBEDDING_DIM` | 임베딩 API 주소·모델·해당 모델의 차원                         |

키를 변경한 뒤에는 `docker compose up -d --force-recreate lightrag`로 반영하세요. `restart`만으로는 환경변수가 갱신되지 않습니다. 임베딩 모델 변경은 재색인이 필요합니다. 키가 비어 있으면 실행 준비가 끝난 것이 아니며 health 성공만으로 키 유효성을 판단하지 않습니다.

GUI의 **Knowledge → Connect a source → API key**는 아래의 `LIGHTRAG_API_KEY`(서버 접속용)입니다. 여기에 모델 제공업체 API 키를 넣지 마세요. 모델 키 입력은 현재 이 예제의 `.env` 편집으로 합니다. 서버 API 인증을 쓰려면 별도의 무작위 `LIGHTRAG_API_KEY`와 `WHITELIST_PATHS=/health`를 설정하고 같은 서버 키를 GUI에 입력하세요. 이는 LightRAG WebUI 로그인 계정을 생성하는 설정이 아닙니다.

이 경로는 MCP tracker를 시작하거나 기존 tracker 등록을 바꾸지 않습니다. `LIGHTRAG_PORT`를 바꿨다면 아래 URL과 등록 URL도 맞추세요. 재현 기록에는 실제 이미지 digest, LLM/embedding 모델, embedding 차원을 남기세요. Compose의 `latest` 태그만으로 버전이 고정되지는 않습니다.

## 2. Knowledge에 등록하고 세 문서를 색인하기

Gateway를 같은 호스트에서 실행한 뒤 **Knowledge → Connect a source**에서 LightRAG를 선택합니다.

| 필드          | 예제 값                                                          |
| ------------- | ---------------------------------------------------------------- |
| Foundation id | `acme.returns-kb`                                                |
| Server URL    | `http://127.0.0.1:9621`                                          |
| description   | `Acme returns policy, shipping SLAs, and the escalation matrix.` |
| kind          | `local`                                                          |
| mode          | `mix`                                                            |
| apiKey        | 서버에 인증을 설정한 경우에만 같은 키를 안전하게 입력            |

**Add to config → Save & Publish** 후 **Test connection**을 확인합니다. `kind: local`은 문서 관리를 허용한다는 선언이며, 검색 모드 `mode: local`과 다릅니다. 기존 `acme.returns-kb`가 있으면 새로 중복 등록하지 말고 그 연결·소유자를 확인하세요.

**Show files**에서 다음 파일만 올리고 모두 **Indexed**가 될 때까지 확인합니다. 업로드 수락이나 **Reachable**은 색인·검색 성공이 아닙니다.

| 업로드 파일                                            | 검증할 내용                                         |
| ------------------------------------------------------ | --------------------------------------------------- |
| [returns-policy.md](knowledge/returns-policy.md)       | 배송일부터 30일, 포장 누락 15%, 환불 승인·처리 규칙 |
| [shipping-sla.md](knowledge/shipping-sla.md)           | 배송 목표, 지연·분실·추적 규칙                      |
| [escalation-matrix.md](knowledge/escalation-matrix.md) | 관리자·물류 담당자 의뢰와 응답 기한                 |

## 3. 실제 검색 결과를 먼저 확인하기

인증을 설정하지 않은 **로컬 데모 서버**에서만 다음 명령을 그대로 사용할 수 있습니다. 인증 서버에서는 인증된 UI를 사용하거나 승인된 비밀 관리 방식으로 `X-API-Key`를 전달하세요.

```bash
curl --fail --silent --show-error --max-time 120 \
  http://127.0.0.1:9621/query/data \
  -H 'Content-Type: application/json' \
  --data '{"query":"When does the Acme return window start?","mode":"mix","top_k":5,"chunk_top_k":5}'
```

`status`가 `success`이고 `data.chunks[].file_path`와 비어 있지 않은 `data.chunks[].content`가 반환되는지 확인하세요. 검색 실패는 결과 없음과 구분합니다. ClawWorks 어댑터는 이 청크를 `snippets`로 변환합니다. 답변 문자열만 있고 청크가 없다면 “정책 검색 통과”가 아닙니다. 요청·응답 필드는 [LightRAG query router](https://github.com/HKUDS/LightRAG/blob/main/lightrag/api/routers/query_routes.py)와 [현재 어댑터](../../../extensions/lightrag/src/adapter.ts)를 기준으로 합니다.

## 4. Chat과 노드 범위 검증하기

[반품 work-map](acme-returns.worktree.yaml)을 **Enterprise → Worktree → Import file**에서 검토·저장하고 `enforce` 모드를 사용합니다. 다른 설치 트리와 함께 쓰는 경우 History에서 실제 `treeId=acme.returns`와 활성 노드를 확인하세요. 기존 트리/운영 설정을 검증표에 맞추려고 덮어쓰지 마세요.

정책 검색은 `returns.triage`의 `knowledgeFoundations: [acme.returns-kb]`와 `knowledge_search` 허용으로 제한됩니다. 이 예제는 inherited grants이므로 lookup/decide의 foundation 목록 생략만으로 검색 금지라고 간주하지 마세요. 도구 허용·승인과 foundation 범위는 별개입니다. LR10은 목록이 명시된 triage의 범위 차단을 검사합니다. 해당 노드에 진입하지 않았다면 그 노드의 차단 검사를 통과로 세지 않습니다. Chat이 도구 호출 전에 거절한 경우에도 실제 gate 검증과 구별합니다.

이 work-map은 embedded 런타임용 예제입니다. 현재 런타임에서 도구가 노출되지 않으면 준비 미완료로 기록하고 [원본의 런타임 주의사항](acme-returns.worktree.yaml)을 확인하세요. 통과를 위해 다른 노드의 권한을 넓히지 마세요. MCP·skill까지 이어지는 통합 검사는 [RET01–RET06](../golden/MANUAL_MATRIX.ko.md#ret01ret06-실제-반품-tracker와-skill)에서 별도로 수행합니다.

LR02–LR08은 새 Chat에서 시작해 실제 `returns.triage` 진입과 `knowledge_search` 호출을 확인합니다. 반환값의 `searched`에 `acme.returns-kb`, `snippets`에 해당 원문과 source가 있어야 하며, 답변은 실제 반환 근거를 인용해야 합니다. 정확한 검색 순위·청크 수·표현은 고정하지 않습니다. 정책만 묻는 케이스에서 주문 조회·환불·발송은 수행하지 않습니다.

| ID   | 입력 또는 조작                                                                                                                          | 기대 결과와 실패 기준                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LR01 | 세 파일 업로드 후 문서 상태 확인. 3절의 직접 query 실행.                                                                                | 세 파일 Indexed, 실제 reference 청크와 반환 파일 경로 확인. health만 성공하거나 청크가 없으면 검색 미검증.                                                          |
| LR02 | Acme 반품 정책에서 반품 기간의 시작일과 기간을 검색하고 출처를 알려줘. 주문은 조회하지 마.                                              | returns-policy.md: 주문일이 아닌 배송일부터 30일. 실제 검색 없이 숫자만 맞히면 실패.                                                                                |
| LR03 | Acme 반품 정책에서 원래 포장이 없을 때 수수료와 반품 배송비 부담 규칙을 찾아줘.                                                         | returns-policy.md: 포장 누락 15%; 고객 부담이 기본, 파손·오배송은 Acme 부담.                                                                                        |
| LR04 | Acme 환불이 언제 시작되고 어디로 지급되며 며칠 안에 정산되는지 정책에서 찾아줘.                                                         | returns-policy.md: Leeds 반품 스캔 후, 원래 결제 수단, 5영업일. 스토어 크레딧은 고객 요청 시. 실제 환불 완료 주장 없음.                                             |
| LR05 | Acme의 250 USD 초과 환불 승인자와 관리자 응답 기한을 두 정책에서 찾아 비교해줘.                                                         | returns-policy.md + escalation-matrix.md의 실제 청크 필요. 관리자 사전 승인, 1영업일 내 응답. 청크 하나만 읽고 두 문서 조회를 주장하면 실패.                        |
| LR06 | Acme Standard 배송 목표와 지연·분실 기준을 배송 정책에서 검색해줘.                                                                      | shipping-sla.md: 목표 3–5영업일, 7일 초과 지연, 14일 기준 분실 규칙. 배송 스캔 기준과 달력일/영업일 구별.                                                           |
| LR07 | Acme 배송 스캔이 72시간 없으면 바로 분실인가? 배송 정책 원문으로 설명해줘.                                                              | shipping-sla.md: 정상 배송 기간 안이면 mis-sorted, 먼저 운송사 추적 요청. 무조건 분실·교환으로 단정하지 않음.                                                       |
| LR08 | Acme의 화성 배송 보험료와 우주선 운송사 규칙을 검색해줘. 문서에 없으면 없다고 해.                                                       | 세 문서에 해당 근거 없음. 관련 청크가 반환돼도 없는 보험료/운송사를 만들지 않음. 반드시 0청크여야 한다는 조건은 아님.                                               |
| LR09 | Acme 반품 정책 단계에서 knowledge_search를 query="return window", foundations=[]로 호출해줘.                                            | 실제 빈 배열 호출이면 snippets/searched/skipped 모두 빈 배열. 모든 foundation 검색으로 확대되면 실패. 호출 안 하면 도구 인자 계약 미검증.                           |
| LR10 | Acme 반품 정책 단계에서 knowledge_search를 query="return window", foundations=["demo.unattached-kb"]로 호출해줘. 다른 소스로 바꾸지 마. | triage 유지. 실제 호출 시 요청 ID가 skipped에 범위 밖 사유로 표시되고 조회되지 않음. 존재하지 않는 테스트 ID여도 노드 허용 범위 밖임을 검사.                        |
| LR11 | Acme 반품 정책 단계에서 knowledge_search를 query="return window", foundations=["acme.returns-kb"], limit=1로 호출해줘.                  | 실제 인자와 반환 청크 1개 이하 확인. 단일 foundation의 결과 상한 검사이며 정확한 검색 순위는 고정하지 않음. 0개면 상한은 만족해도 정책 검색 성공은 미검증.          |
| LR12 | 전용 데모 서버에서만 `docker compose stop lightrag` 후 LR02를 새 Chat에서 재실행. 종료 후 `docker compose up -d lightrag`로 복구.       | 실제 검색 시 searched에 실패한 foundation이 없고 skipped에 retrieval failed. 정상 검색 0건과 구별하고 정책을 꾸미지 않음. 도구 자체가 없으면 장애 전파 검증 미충족. |

## 5. 0건 원인과 결과 기록

| 관측                                              | 먼저 확인할 것                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| knowledge_search 자체 없음                        | foundation 등록·Publish, enterprise 활성화, 런타임 도구 노출                           |
| skipped에 범위 밖 사유                            | 활성 tree/node와 해당 경로의 knowledgeFoundations; 권한을 넓혀 우회하지 않기           |
| skipped에 retrieval failed                        | 서버 연결, 인증, LLM/embedding, 서버 로그; 비밀값은 보고서에 제외                      |
| searched에 foundation이 있지만 snippets 비어 있음 | 실제 Indexed 상태와 references.content; 모델의 response만으로 성공 판정하지 않기       |
| search_objects가 0건                              | 별도 ontology 객체 저장소임. LightRAG에 정책을 올려도 주문·보험금 객체가 생성되지 않음 |

각 LR ID에 질문, 런타임·모델, tree/node, 실제 도구 인자, searched/skipped/snippets/source, 판정과 재시험 ID를 남기세요. `준비 미완료`, `실제 불일치`, `호출 전 거절`, `gate 차단 확인`, `통과`를 구분합니다. 이 기대 결과 문서를 foundation이나 skill에 업로드하지 마세요. 정답을 검색하도록 만들어 실제 정책 조회를 가장하게 됩니다.

마지막으로 전용 서버의 상태를 원래대로 복구하세요. 이 가이드는 문서 삭제나 인덱스 초기화를 요구하지 않습니다. 서비스만 종료하려면 같은 디렉터리에서 `docker compose stop lightrag`를 사용합니다.
