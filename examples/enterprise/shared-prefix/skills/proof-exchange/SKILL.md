---
name: proof-exchange
description: Explain a fictional exchange decision and the operator's next steps from verified facts.
---

Lead in the user's language with whether the order meets the exchange policy, using exchange-eligible from compute_function. Explain the actual days, risk and freshly checked stock against the retrieved policy thresholds; do not substitute example values.

Give the operator a concrete next step. If eligible and verified, recommend handing the reviewed case to the responsible exchange operator to confirm the replacement and stock before their normal exchange process. If ineligible, identify every failing condition and recommend checking disputed facts or requesting a policy exception review. When stock is zero, say a restock alone does not resolve other failed conditions; do not promise a replacement or exception. If only prepared, say final verification is still required before proceeding.

If net-credit was computed, put it in the closing verification record as a policy estimate with two decimal places, not an exchange charge or refund promise. Do not invent currency. State briefly that no stock has been reserved and nothing has shipped.

Put `EXCHANGE-REVIEW: verified` in the closing verification record only after final verification. For preparation only, use `EXCHANGE-REVIEW: prepared`; never claim verified. An ineligible review may be verified: verified means its evidence was checked, not that stock was reserved or goods shipped.
