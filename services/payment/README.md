# @krispy/payment

Merchant-of-Record checkout, subscriptions, webhooks, and the **Krispy Cloud
billing** surface, on Hono. **Env-gated**: boots on the `MockProvider` with no
credentials, switches to the real `CreemProvider` when `CREEM_API_KEY` is set.

```bash
bun --filter @krispy/payment dev      # http://localhost:3002  (port: PAYMENT_PORT, default 3002)
bun --filter @krispy/payment test     # provider + billing (mocked Creem) tests
```

## Pricing this implements

| Plan          | Price                       | Trial                | Access                                     |
| ------------- | --------------------------- | -------------------- | ------------------------------------------ |
| **Self-host** | free forever                | —                    | always entitled, unmetered (tenant `self`) |
| **Cloud**     | **$19/mo** (or **$190/yr**) | **14 days, no card** | metered caps, cancel anytime               |

The 14-day trial is **ours**, not Creem's: it's granted at Cloud sign-up (no
checkout, no card) and enforced live by the entitlement gate. Creem only enters
when the user actually subscribes.

## Routes

Legacy single-checkout (unchanged): `GET /health`, `POST /checkout`, `POST /webhook`.

Krispy Cloud billing, under **`/api/billing`**:

| Method | Path                    | Body / Query                                   | Returns                                              |
| ------ | ----------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| POST   | `/api/billing/checkout` | `{ tenantId, interval?, email?, successUrl? }` | `{ id, checkoutUrl }` (Creem hosted checkout)        |
| POST   | `/api/billing/webhook`  | raw body + `creem-signature`                   | `{ received: true }` — verifies sig, updates the row |
| POST   | `/api/billing/portal`   | `{ tenantId }`                                 | `{ url }` (Creem self-service portal)                |
| GET    | `/api/billing/status`   | `?tenantId=`                                   | `{ plan, status, entitled, limits, trialEndsAt, … }` |

`interval` is `monthly` (default) or `annual`.

## Architecture

```
libs/billing (@krispy/billing) ── the brain (shared, DB-backed)
  plans.ts        plan catalogue, $19/$190, 14-day trial, Cloud caps, product-id-from-env
  entitlement.ts  PURE: entitled(sub, now), trial math, snapshot, withinLimits
  webhook.ts      PURE: Creem event → subscription patch (idempotent, absolute state)
  repo.ts         Drizzle: startTrial, getByTenant, applyEvent (@krispy/db)
  sync.ts         pushEntitlement(): mirror the snapshot to the edge gate (no polling)

services/payment ── the HTTP surface
  provider.ts     PaymentProvider adapter: Creem (default) · Dodo (skeleton) · Mock
  billing.ts      createBillingApp({ provider, repo, sync }) — the /api/billing router

libs/auth         on sign-up → billingRepo.startTrial() + pushEntitlement() (best-effort)
libs/db           subscription table (one row per tenant; absent row = free/self-host)
services/edge     entitled(tenant) gate + KV entitlement snapshot + metering vs plan
```

**Entitlement flow (push, never poll).** The DB is the source of truth (Postgres,
in the payment service). The gate runs in the edge Worker (workerd, can't reach
Postgres). So every billing change — trial start, subscribe, cancel, payment
failure — **pushes** a pre-computed snapshot (`{ plan, status, entitled, limits, … }`)
to the edge Worker's guarded `POST /api/billing/entitlement` route, which writes it
to KV. The gate reads KV: `self` is always entitled/unmetered; a Cloud tenant is
entitled per its last snapshot; **no snapshot → fail closed**. Idle clients make
zero requests.

**Idempotent webhooks.** `mapEvent` produces *absolute* state (status, period end),
so replaying `subscription.active` lands on the same row — no dedupe table needed.

**Provider-agnostic.** Everything hits the `PaymentProvider` interface
(`createCheckout` / `verifyWebhook` / `createPortal`). Creem is the concrete
default; swapping to Dodo is one env var.

## Creem contract (verified against docs.creem.io)

- **Checkout:** `POST {base}/v1/checkouts`, header `x-api-key`, body
  `{ product_id, request_id, success_url, customer:{ email } }` → `{ id, checkout_url }`.
  We pass `request_id = tenantId` so the webhook can attribute the subscription back.
- **Webhook:** header `creem-signature` = **hex HMAC-SHA256(rawBody, CREEM_WEBHOOK_SECRET)**,
  compared with `crypto.timingSafeEqual`. Events handled: `checkout.completed`,
  `subscription.active|paid|update` → active, `subscription.trialing` → trialing,
  `subscription.past_due` → past_due, `subscription.canceled|scheduled_cancel|expired|paused`
  + `refund.created` + `dispute.created` → canceled.
- **Portal:** `POST {base}/v1/customers/billing`, body `{ customer_id }` →
  `{ customer_portal_link }` (older docs: `billing_portal_url` — both handled).
- Base URL from key prefix: `creem_test_` → `https://test-api.creem.io`, else `https://api.creem.io`.

## Env

```
PAYMENT_PROVIDER=creem        # optional: creem | dodo | mock (else auto-detect by key)
CREEM_API_KEY=                # creem_test_… (sandbox) or creem_… (live). Unset → Mock.
CREEM_WEBHOOK_SECRET=         # Developers → Webhook in the Creem dashboard
CREEM_PRODUCT_ID_MONTHLY=     # the $19/mo subscription product id
CREEM_PRODUCT_ID_ANNUAL=      # the $190/yr subscription product id (optional)

# Push entitlement to the edge gate (see services/edge). Unset → no-op (self-host).
EDGE_ENTITLEMENT_URL=https://<edge-worker-host>/api/billing/entitlement
BILLING_SYNC_SECRET=          # must match the edge Worker's BILLING_SYNC_SECRET
```

## Create the products in Creem

1. Creem dashboard → **Products → New** → **Recurring / Subscription**.
2. **Monthly:** price **$19.00**, billing period **monthly**. Copy the product id →
   `CREEM_PRODUCT_ID_MONTHLY`.
3. **Annual** (optional): price **$190.00**, billing period **yearly** →
   `CREEM_PRODUCT_ID_ANNUAL`.
4. (Optional) If you want Creem to *also* enforce a card-required trial, add a trial
   period on the product. Not required — the no-card 14-day trial is app-side.
5. **Developers → Webhook:** add an endpoint pointing at
   `https://<payment-host>/api/billing/webhook`, copy the signing secret →
   `CREEM_WEBHOOK_SECRET`. Subscribe to the `checkout.*` + `subscription.*` +
   `refund.created` + `dispute.created` events.

## Go-live checklist (accept real money)

- [ ] Run the DB migration: `bun --filter @krispy/db migrate` (creates `subscription`).
- [ ] Create the monthly (+ annual) subscription products in Creem (above); set
      `CREEM_PRODUCT_ID_MONTHLY` / `CREEM_PRODUCT_ID_ANNUAL`.
- [ ] Set `CREEM_API_KEY` to a **live** key (`creem_…`) and `CREEM_WEBHOOK_SECRET`.
- [ ] Register the webhook endpoint in Creem → confirm a test event returns `200`
      and flips a `subscription` row.
- [ ] Set `BILLING_SYNC_SECRET` (same value) on **both** the payment service and the
      edge Worker; set `EDGE_ENTITLEMENT_URL` to the Worker's public host.
- [ ] Smoke a real checkout in Creem test mode → complete → confirm the row goes
      `trialing → active`, the snapshot reaches the edge, and `entitled` chats work.
- [ ] Confirm the portal opens for a subscribed tenant (`POST /api/billing/portal`).

## Honest status: mocked vs live

- **Live & verified against Creem's public REST contract:** checkout, webhook
  signature verification, portal — the request/response shapes above are the
  documented ones.
- **Confirm before you flip live traffic on:** the exact JSON *field casing* inside
  Creem's webhook subscription objects (`current_period_end_date`, nested
  `subscription.id` / `customer.id`). `webhook.ts` reads them tolerantly with
  fallbacks, but check one real webhook sample from your dashboard against
  `mapEvent`. The portal response key is handled both ways.
- **Fully mocked in tests** (`bun test`, no network, no DB, no Creem creds): the
  `MockProvider`, an in-memory `BillingRepo`, and a spy for the edge push. Trial
  math, entitlement across every state, idempotent webhook handling, the signature
  accept/reject path (real HMAC), checkout payload shape, and metering-vs-plan are
  all covered. See `src/billing.test.ts` and `libs/billing/src/billing.test.ts`.
- **Dodo** remains a compile-checked skeleton (second MoR, proves the adapter
  swaps) — not wired for live traffic.
