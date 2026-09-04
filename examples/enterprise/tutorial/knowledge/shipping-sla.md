# Acme shipping service levels

## Delivery targets

| Service  | Target            | Carrier           |
| -------- | ----------------- | ----------------- |
| Standard | 3-5 business days | Northwind Post    |
| Express  | 1-2 business days | Northwind Post    |
| Bulky    | 5-8 business days | Cormorant Freight |

Targets are counted from the shipment scan, not from the order.

## When a parcel counts as late

- A standard shipment is **late after 7 calendar days** in transit, and the
  customer is offered the shipping fee back.
- A shipment still in transit after **14 calendar days is treated as lost**. Do
  not ask the customer to keep waiting: open a carrier claim and send a
  replacement the same day.
- A carrier claim must be filed within 30 days of the shipment scan. After that
  the carrier refuses it and the loss stays with Acme.

## Tracking

Every shipment has a carrier tracking number. "No scan for 72 hours" on an
otherwise in-window shipment means the parcel is mis-sorted, not lost — ask the
carrier to trace it before promising a replacement.

## Address problems

A parcel returned to sender for a bad address is re-shipped once at no cost.
A second failure is refunded, minus the shipping fee.
