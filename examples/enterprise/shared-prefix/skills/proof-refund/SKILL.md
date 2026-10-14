---
name: proof-refund
description: Explain a fictional refund decision and the operator's next steps from verified facts.
---

Lead in the user's language with whether the order meets the refund policy, using refund-eligible from compute_function. Explain the actual days, order total and risk against the retrieved policy thresholds; do not substitute example values.

Give the operator a concrete next step. If eligible and verified, recommend handing the reviewed case to the responsible refund operator to confirm the payable amount and any required approval in their normal refund process. If ineligible, identify the failing conditions and recommend checking disputed facts or requesting a policy exception review; do not promise an exception. If only prepared, say final verification is still required before proceeding.

When net-credit was computed, show it as a policy estimate, with two decimal places, separately from the order total. Explain the retrieved formula (total × 0.9); do not call it the approved refund amount or invent a fee, deduction reason or currency. Do not calculate net-credit for a preparation-only request. State briefly that no refund has been paid.

Put `REFUND-REVIEW: verified` in the closing verification record only after final verification. For preparation only, use `REFUND-REVIEW: prepared`; never claim verified. An ineligible review may be verified: verified means its evidence was checked, not that a refund was approved or paid.
