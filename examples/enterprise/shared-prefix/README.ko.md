# 공통 3단계 + 서로 다른 마지막 2단계 검증

작성일: **2026-10-13**. 모든 데이터는 가상 주문이며 실제 결제·예약·발송을 하지 않습니다.

```text
case                         1. 사건 생성 + 접수/개인정보 지식 검색
└─ case.order                2. 주문/위험 MCP 조회 + 고객·주문·품목·위험 그래프 저장
   └─ case.order.assess      3. 주문/위험/재고 MCP 재조회 + 정책 검색·평가·근거 연결
      ├─ …refund             4a. 환불 검토 준비
      │  └─ …refund.finalize 5a. 위험 재확인 + 근거 검증 + 검토 확정
      └─ …exchange           4b. 교환 검토 준비
         └─ …exchange.finalize 5b. 재고 재확인 + 근거 검증 + 검토 확정
```

각 노드는 실행 단계입니다. 환불만 요청하면 5개, 교환만 요청하면 다른 5개가 실행됩니다. 둘 다 요청하면 공통 3개를 한 번씩 실행한 후 환불 2개 → 교환 2개, 총 7개가 실행됩니다. 공통 근거만 요청하면 3개에서, 환불 준비만 요청하면 4개에서 멈춥니다.

## 포함 데이터와 검증 기준

- [워크맵 번들](shared-prefix.clawworks-bundle.yaml): 지식 소스 5개, MCP 연결 3개, 스킬 4개, 객체 유형 10개, 관계 11개, 계산 함수 3개, 액션 7개.
- [주문 데이터](records.json): `1043`은 6일·129달러·위험 12·재고 3, `1051`은 96일·310달러·위험 72·재고 0. 전자는 양쪽 적격, 후자는 양쪽 부적격. `9999`는 조회 오류로 2단계에서 중단합니다.
- 복합 그래프: 사건 → 주문 → 품목/위험, 고객 → 주문, 사건 → 평가 → 주문/위험/근거 → 정책, 환불/교환 검토 → 평가. 다중 객체·관계 생성은 하나의 액션으로 처리합니다.
- 공통 평가 노드에는 지식 소스 3개·MCP 3개·스킬 2개와 객체 유형 8개·관계 9개가 동시에 붙습니다. 부모 단계의 권한을 상속하지 않고 필요한 선언을 각 노드에 명시합니다.
- 스킬은 선택한 경로 전체의 합집합으로 로드됩니다. 노드별 비밀 격리를 뜻하지 않습니다. 실제 모델 답변의 `EVIDENCE: linked-policy-verified`, `REFUND-REVIEW: verified`, `EXCHANGE-REVIEW: verified` 표식과 DB 결과를 함께 확인합니다. 준비만 한 경우에는 `prepared`만 허용합니다.
- 미선택 분기의 검토 객체가 생기지 않아야 합니다. 단계 밖 MCP·검색·객체 접근, 순서가 틀린 단계 완료, 없는 객체에 연결하는 부분 유효 액션도 검사합니다. 마지막 연결이 실패하면 앞의 객체 생성도 남지 않아야 합니다.
- 검증 실행 중 발견한 Responses 전송 오류도 수정했습니다. 최종 이벤트로만 받은 도구 인수가 실행용 응답에 반영되지 않아 빈 인수로 재시도하던 문제입니다. [공식 호출 계약](https://developers.openai.com/api/docs/guides/function-calling)과 저장소의 다른 Responses 처리 경로를 대조하고, 최종 응답 객체를 검사하는 회귀 테스트를 추가했습니다.
- 실제 모델 검증은 중간 도구 인수 검증 오류도 실패로 판정합니다. 공유 보고서에는 도구 인수·결과·최종 답변을 보존하며 모델 내부 추론과 provider replay 데이터는 제외합니다.

## 재현

저장소 루트에서 실행합니다. 실행 기록은 저장소 밖에 저장합니다.

```bash
pnpm test src/enterprise/shared-prefix.test.ts
pnpm exec tsx scripts/enterprise-shared-prefix-proof.ts --out /tmp/shared-prefix-scripted.json
pnpm exec tsx scripts/enterprise-routing-eval.ts --cases examples/enterprise/shared-prefix/routing-cases.yaml --repeat 3 --model openai/gpt-5.5 --out /tmp/shared-prefix-routing.json
pnpm exec tsx scripts/enterprise-shared-prefix-proof.ts --model openai/gpt-5.5 --out /tmp/shared-prefix-live.json
```

`--case refund|exchange|both|ineligible|evidence|prepared|unknown`으로 한 시나리오만 재현할 수 있습니다. 모델 옵션을 생략하면 작성된 호출 순서로 회귀 검증합니다. 모델을 지정하면 기존 인증을 사용한 실제 라우터가 경로를 결정하고, 실제 agent-core 루프가 도구와 `complete_step`을 호출합니다. 기대 경로, 단계별 도구, 그래프·적격 값, 스킬 표식을 자동 대조합니다. 테스트와 실제 모델 검증을 구분해 기록합니다.

실행기는 임시 SQLite 상태를 만들고 종료 시 정리합니다. 실제 MCP stdio 프로세스 3개를 시작하여 production MCP bridge와 도구 호출 전 권한 게이트를 통과시킵니다. 지식 검색은 번들에 담긴 로컬 소스를 사용합니다. 외부 LightRAG 검색 품질, GUI, native Codex/다른 harness, 실서비스 결제·배송은 이 검증 범위에 포함하지 않습니다.

## GUI에서 직접 실행하기

1. 번들을 워크맵 화면에서 가져옵니다.
2. `skills/`의 네 폴더를 해당 에이전트 workspace의 `skills/` 아래에 복사합니다.
3. MCP 설정에 아래 세 서버를 등록합니다. 경로를 실제 체크아웃의 절대 경로로 바꿉니다.

```json
{
  "mcp": {
    "servers": {
      "proof-orders": {
        "command": "node",
        "args": ["/path/to/openclaw/examples/enterprise/shared-prefix/mcp.mjs", "orders"]
      },
      "proof-risk": {
        "command": "node",
        "args": ["/path/to/openclaw/examples/enterprise/shared-prefix/mcp.mjs", "risk"]
      },
      "proof-stock": {
        "command": "node",
        "args": ["/path/to/openclaw/examples/enterprise/shared-prefix/mcp.mjs", "stock"]
      }
    }
  }
}
```

[검증 질의](scenarios.json)를 복사해서 요청합니다. 수동 재실행에서는 매번 새로운 `case-id`를 사용해야 합니다. 주문 객체까지 새로 생성하는 데이터이므로 같은 주문을 여러 번 비교하려면 격리된 상태를 쓰는 위 실행기를 권장합니다. 기존 주문 그래프를 갱신하는 운영용 워크맵은 아닙니다. 노드별 MCP 범위를 지원하는 host-dispatched runtime에서 실행합니다.
