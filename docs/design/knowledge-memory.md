# Design Doc — Knowledge & Memory (ImmorTerm-powered)

**Status:** Draft / build-ready. **Owner:** (founder). **Last updated:** 2026-07-03.
**Powered by [ImmorTerm Memory](https://immorterm.com).** This is an honest ecosystem play — ImmorTerm is the founder's own product, and Krispy is its first external open-core consumer (see §10).

> Confidence tags on every non-obvious claim: `high` (verified in a repo file, cited) · `moderate` (design inference from verified pieces) · `low` (guess, needs confirmation) · `unknown`.

## Locked decisions (founder, 2026-07)
1. **Model:** open-core, **opt-in, OFF by default** (`KNOWLEDGE_PROVIDER=none`). Open source = the adapter interface + ImmorTerm adapter + null fallback + all wiring. Cloud-managed = we host the sidecar/Factory + own the tenant-auth boundary. Never hard-couple to ImmorTerm (no-lock-in).
2. **Cold-path home:** a **new `services/memory`** (its own Node service) — *not* `services/payment`. Separation of concerns; knowledge lifecycle ≠ billing.
3. **Managed tenancy:** **one shared sidecar**, tenant isolation enforced by the Worker-derived pack handle (client never names a pack). Per-tenant sidecars = a future Enterprise tier only.
4. **Pack handles:** deterministic **non-reversible slug** `tenant-<hash(tenantId)>` (fits `^[a-z0-9-]{1,64}$`); store the `tenantId → packName` mapping in tenant KV for support/debug lookup.

---

## 1. Overview & goals

### What this enables

Krispy today answers every visitor turn with a **static** system prompt (`services/edge/src/system-prompt.ts` — a fixed `DEFAULT_PROMPT` or a per-tenant override, `high`). The bot knows the handoff contract and a tone, but it does **not** know the tenant's product, pricing, docs, or FAQ, and it forgets every visitor between sessions. Three capabilities close that gap:

1. **Per-tenant knowledge retrieval (KB → grounded answers).** A tenant uploads their docs/FAQ/pricing once; the bot answers from them instead of hallucinating or handing off. This is the headline feature.
2. **Cross-session visitor memory (a differentiator).** "You helped me set up X last week" — the bot recalls a returning visitor's prior context. Intercom/Crisp gate this behind their AI tiers; Krispy makes it a first-class, self-hostable primitive.
3. **Semantic answer cache (a cost lever).** The pack's pre-baked digest (RAM) is a stable, cacheable prefix; per-turn retrieval pulls only the top-K relevant chunks instead of re-stuffing the whole KB.

### The cost math — why retrieval beats stuffing

Krispy's chat cost is already **quadratic in conversation length**: the widget re-sends the whole history each turn (`services/edge/src/chat.ts:14` comment, `high`). The existing turn-tax guards — `MAX_HISTORY_MSGS=8` sliding window, `MAX_AI_TURNS=10`, `MAX_OUTPUT_TOKENS` cap (`chat.ts:19-24`, `high`) — bound the *history* growth. Knowledge would **re-introduce** unbounded input if we naively stuffed the whole KB into the prompt every turn.

| Approach | Per-turn input tokens (illustrative) | Notes |
|---|---|---|
| Stuff whole KB every turn | KB size (e.g. 50K chars ≈ 12.5K tok) × every turn | Quadratic again; kills the turn-tax work. |
| **RAM digest + top-K search** | ~20K-char digest (≈ 5K tok, **cacheable**) + K×~500 tok retrieved | Digest is stable → prompt-cacheable; only the small top-K varies. `moderate` |
| Size-gated (small KB) | Inline the KB once, cache it, **no retrieval** | Below the gate, retrieval isn't worth the RTT (§7). `moderate` |

**RAM** = a pre-baked ~20K-char markdown digest of a pack, fetched via `GET /api/v1/packs/ram?pack_name=` — "the token-savings primitive, meant for the cacheable system-prompt prefix" (`immorterm/services/memory/src/routes/packs.rs:38-47`, `high`). **search_pack** (`POST /api/v1/packs/search`) = per-turn semantic retrieval (`packs.rs:98-112`, `high`).

### Non-goals

- Not building our own embedder/vector DB — the ImmorTerm sidecar ships a SQLite + in-process embedder (`high`, per research brief + `immorterm/services/memory/src/{vector,embedding}.rs`).
- Not hard-coupling Krispy to ImmorTerm (§2).
- Not a RAG framework for arbitrary agents — scoped to the Krispy live-chat turn.

---

## 2. The open-core / opt-in / cross-promo model

**These are settled decisions — bake them in, don't re-litigate.**

### What is OSS (in the Krispy repo, MIT-licensed like the rest)

- The **`Knowledge` adapter interface** (§3) — a small TypeScript interface, the "no lock-in" seam.
- The **ImmorTerm adapter** — the blessed default implementation of that interface, a thin `fetch()` client against the sidecar + Factory REST APIs.
- A **null / minimal fallback adapter** — so a self-hoster who never opts in gets a working (memory-less) bot with **zero** new dependencies or sidecar.
- All the **edge wiring** (RAM injection into the cacheable prefix, top-K search, timeout + graceful-empty), the **KV cache layer**, the **Node lifecycle** (pack build/import), and the **tenant→pack auth mapping**.

### What is Cloud-managed (the paywall — hosting/ops, NOT code)

- Krispy Cloud **hosts the ImmorTerm sidecar + Factory** for tenants (managed, multi-tenant, backed up).
- Krispy Cloud **owns the tenant-auth boundary** in front of the no-auth sidecar (§6) — the real operational work.
- On-brand pitch: **"self-host free, pay us to not run infra."** Photoshop-style — the *code* is open; the *managed hosting + the auth boundary + ops* is the value-add. Same shape as the existing entitlement gate (`services/edge/src/store.ts:193 entitled()`, `high`) — `self` is always unmetered; Cloud tenants pay.

### The config flag (opt-in, OFF by default)

A single env/config decides whether Knowledge is live at all:

```
KNOWLEDGE_PROVIDER = "none" (default) | "immorterm"
IMMORTERM_MEMORY_URL = ""   # sidecar base URL — empty ⇒ null adapter
IMMORTERM_PACKS_URL  = ""   # Factory base URL — empty ⇒ builds disabled
```

- `KNOWLEDGE_PROVIDER=none` **or** `IMMORTERM_MEMORY_URL` empty → the null adapter is wired; the bot behaves exactly as today. Self-host stays dependency-free. `high` (this is the whole point of decision #1).
- `KNOWLEDGE_PROVIDER=immorterm` + a sidecar URL → the ImmorTerm adapter is wired. Naming/env conventions follow Delulus (`IMMORTERM_MEMORY_URL` / `IMMORTERM_PACKS_URL`, `delulus/.../founder-memory.ts:34-37`, `high`) and Krispy's no-hardcoded-URL rule (`.env.example` uses `*.krispy.localhost:1355` placeholders, `high`).

### The no-lock-in boundary (brand-critical)

Krispy's brand is "own your data / no lock-in" (`README.md:26,116-119`, `high`). The adapter interface is the contract: **Krispy core never imports the ImmorTerm client directly** — it depends only on the `Knowledge` interface, and the ImmorTerm adapter is injected at the edge (exactly how `chatFlow` already takes injected deps — `chat.ts:29-49 ChatDeps`, `high`). Swap in a Pinecone adapter, a Postgres-pgvector adapter, or the null adapter without touching the flow. `high`

---

## 3. Architecture

### 3.1 The `Knowledge` adapter interface (the seam)

A single lib — proposed `libs/knowledge` (a `type:lib`, one `src/index.ts` barrel per the monorepo law, `AGENTS.md:§3`, `high`). It exports the interface + the three implementations. Nothing in `libs/` may import from `apps`/`services` (`AGENTS.md` law #1), which fits — this is pure shared code.

```ts
// libs/knowledge/src/index.ts  (proposed)
export interface Knowledge {
  // ── COLD path (Node lifecycle; §3.4) ────────────────────────────
  /** Idempotent: ensure a pack exists for this handle (create if absent). */
  ensurePack(pack: string, opts?: { title?: string }): Promise<void>;
  /** Add/replace KB content on a pack (triggers a Factory rebuild). */
  upsertKnowledge(pack: string, sources: KnowledgeSource[]): Promise<void>;
  /** Export the pack as portable .impack bytes (data-ownership / migration). */
  exportPack(pack: string): Promise<Uint8Array>;

  // ── HOT path (edge Worker, per turn; §3.3) ──────────────────────
  /** Pre-baked digest for the cacheable system-prompt prefix. "" on miss/timeout. */
  getRam(pack: string, opts?: { signal?: AbortSignal }): Promise<string>;
  /** Top-K semantic retrieval for this turn. [] on miss/timeout. */
  search(pack: string, query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<Snippet[]>;

  // ── Visitor memory (§4) ─────────────────────────────────────────
  /** Fire-and-forget: append a snapshot of what we learned about a visitor. */
  rememberVisitor(tenantId: string, visitorId: string, snapshotMd: string): Promise<void>;
  /** Recall a returning visitor's cross-session digest. "" on miss/timeout. */
  recallVisitor(tenantId: string, visitorId: string, opts?: { signal?: AbortSignal }): Promise<string>;
}

export interface KnowledgeSource { content: string; description?: string; type?: "paste" | "url" | "file"; }
export interface Snippet { text: string; score: number; }
```

Method names map 1:1 to the brief's required set: `ensurePack, upsertKnowledge, getRam, search, rememberVisitor, recallVisitor, exportPack`. `high`

### 3.2 The three implementations

| Impl | Behavior | When |
|---|---|---|
| **`NullKnowledge`** | Every method is a no-op; `getRam`→`""`, `search`→`[]`, `recallVisitor`→`""`. | Default. Self-host with no opt-in. Zero deps, zero network. `high` |
| **`ImmortermKnowledge`** | `fetch()` client against sidecar `/api/v1/*` (hot + visitor) and Factory `packs.*` (cold). | `KNOWLEDGE_PROVIDER=immorterm`. `high` |
| **(future) other** | e.g. pgvector. Not in scope; the interface makes it a drop-in. | later `low` |

The `ImmortermKnowledge` adapter is a **direct port** of Delulus's two proven modules, refactored behind the interface:
- HOT reads ← `delulus/services/api/src/routes/chat.ts:476-527` (`searchPack` + `getPackRam`) — verified shapes below. `high`
- Visitor memory ← `delulus/services/api/src/lib/founder-memory.ts` (read = RAM w/ 2s timeout + graceful-empty `:64-94`; write = create-or-extend, fire-and-forget, never throws `:127-222`). `high`
- COLD lifecycle ← `delulus/services/ai-worker/src/pipeline/knowledge.ts` (build→poll→download→R2→import-into-sidecar `:89-174`). `high`

**Verified sidecar contract** (all `high`, cited to `immorterm/services/memory/src/routes/packs.rs` + `mod.rs`):

| Op | Method + path | Request | Response |
|---|---|---|---|
| RAM | `GET /api/v1/packs/ram?pack_name=<p>` | query param `pack_name` (opt `hard`) | `{ ram: string }` (`packs.rs:31-47`; consumer reads `data.ram`, `chat.ts:521`) |
| search | `POST /api/v1/packs/search` | `{ pack_name, query, limit?, type_filter? }` (default `limit=10`, `packs.rs:96`) | `{ results: [{ content?/text?, score, metadata? }] }` (`chat.ts:491-498`) |
| import | `POST /api/v1/packs/import/upload` | multipart, field **`impack`** = .impack bytes | `mod.rs:95`; `knowledge.ts:506-526` |
| export | `GET /api/v1/packs/export/download?format=impack` | query `format` | `application/zip` bytes (`mod.rs:96`) |
| list | `GET /api/v1/packs` | — | `{ packs: [...] }` (`mod.rs:87`) |

**Verified Factory contract** (`packs.immorterm.com`, all `high`, cited to `immorterm/docs/public-api.md`):

| Op | Method + path | Notes |
|---|---|---|
| create/resume | `POST /api/packs` | `mode=raw` (JSON body, `inputs[]`) or `structured\|digest` (multipart file). Idempotent, never 409 (`public-api.md:122-131`). |
| poll | `GET /api/packs/:name` | flat `PackView`: `status: creating\|ready\|error`, `progress`, `downloadUrl` (`public-api.md:364-393`). |
| add source | `POST /api/packs/:name/sources` | dedup by content hash (`public-api.md:568-580`). |
| download | `GET /api/packs/:name/download` | `application/zip` .impack, or use presigned `downloadUrl` (`public-api.md:627-659`). |
| rebuild | `POST /api/packs/:name/rebuild` | discard checkpoint, reuse sources (`public-api.md:584-606`). |
| delete | `DELETE /api/packs/:name` | state-aware (`public-api.md:408-435`). |

> **`.impack`** = `zip(impack.db + agent.md)` — the searchable KB DB + an expert-persona markdown (`knowledge.ts:17-22`, `high`). Krispy uses `impack.db` for retrieval; `agent.md` is *optional* extra system-prompt flavor (Delulus uses it as a rich persona — `chat.ts:680-682`). For Krispy v1, we can ignore `agent.md` and keep the tenant's own `systemPrompt`. `moderate`

### 3.3 The HOT path (edge Worker, per turn)

Runs inside the CF Worker on every `/api/chat` turn. **The retrieval call is a plain `fetch()` → works from workerd** (the sidecar itself is stateful/self-hosted and is NOT edge-hostable — the Worker calls it over the network). `high` (research brief + Delulus runs the identical `fetch` in Node; workerd's `fetch` is compatible).

```
per turn, before deps.ai():
  pack = tenantPack(tenantId)                       // Worker-owned mapping, §6
  ram  = cacheGetRam(pack)  ?? await knowledge.getRam(pack, {signal: timeout(400ms)})
  hits = await knowledge.search(pack, userMessage, {limit: 3, signal: timeout(600ms)})
  // both wrapped in AbortSignal.timeout + graceful-empty → "" / [] on any failure
  systemPrompt = buildSystemPrompt(tenant.systemPrompt, { ram, hits })
```

- **RAM → cacheable prefix.** RAM is stable per KB version, so it goes in the *static* half of the system prompt (Delulus splits "static (cacheable) / dynamic (per-query)" explicitly — `chat.ts:670`, `high`). On providers that support it (BYO-key adapter seam, `ai.ts`), this is the prompt-cache anchor. **Caveat:** Workers AI exposes no `cache_control` knob (`edge/README.md:54`, `high`) — so on the default Workers AI runner, "cacheable" means *our* KV cache (§3.5) saves the sidecar RTT, not provider-side token savings. Provider prompt-cache lands with the BYO-key seam. `high`
- **search → dynamic top-K.** Injected as a `## Relevant context` block after the static prefix (mirrors Delulus's `## Research Summary` injection `chat.ts:694-699`, `high`).
- **Timeout + graceful-empty everywhere.** `AbortSignal.timeout(ms)` (already Delulus's pattern, `founder-memory.ts:77`, `high`) + catch→`""`/`[]`. **Memory slow/down must never block or fail a turn** (§7 failure modes).

`buildSystemPrompt` gets a second optional arg for the injected knowledge — a minimal extension of the existing pure function (`system-prompt.ts:29`, `high`), keeping it unit-testable.

### 3.4 The COLD path (Node service — pack build/import/update)

Pack builds are heavy, async, LLM-driven (`public-api.md:38`, `high`) — **cannot** run in the edge Worker (CPU/time limits, and it's a multi-minute poll loop, `knowledge.ts:68 POLL_TIMEOUT_MS=30min`, `high`). This lives in a **Node service**.

**DECIDED (founder, 2026-07): a new `services/memory`** — its own dedicated Node service. *Separation of concerns:* the knowledge/kbase lifecycle is a distinct domain from billing (`services/payment`) with its own scaling profile (Factory builds + sidecar imports + R2), so it gets its own service rather than bloating payment with unrelated routes. It exposes the dashboard-facing endpoints (`ensurePack`/`upsertKnowledge`/`export`) and talks to the ImmorTerm Factory + sidecar + R2. *(Rejected: folding into `services/payment` — domain mismatch; `services/ai-worker` — has no URL/trigger for the dashboard to call.)*

Cold flow (port of `knowledge.ts:89-174`, `high`):
```
ensurePack/upsertKnowledge:
  POST packs.*/api/packs (or /:name/sources)      // Factory
  poll GET /api/packs/:name until ready|error     // §COLD is async; 5s interval
  GET /api/packs/:name/download → .impack bytes
  store .impack in R2 (durable copy, keyed by pack) // survives sidecar loss
  POST sidecar /api/v1/packs/import/upload (field "impack")
  mark pack status ready in the tenant record
```
The **R2 durable copy** matters: the sidecar is SQLite-on-a-box; if it's rebuilt/lost, re-import from R2 without re-paying the Factory LLM cost (Delulus does exactly this — R2 key `${slug}/packs/${packName}.impack`, `knowledge.ts:469`, `high`).

### 3.5 The KV / Cache-API RAM layer (kill the per-turn edge→sidecar RTT)

Every turn hitting the sidecar for RAM adds an edge→origin RTT. Cache the RAM digest in **Workers KV** (Krispy already uses `KRISPY_KV` for tenant config + usage, `store.ts`, `high`):

```
kRamCache(tenantId) = `ram:${tenantId}:${kbVersion}`   // version in the key = free invalidation
getRam: KV.get → hit? return : miss? fetch sidecar, KV.put(ttl: 300s), return
```
- **Short TTL (~5 min)** bounds staleness even if invalidation is missed.
- **Invalidate on KB edit** — the cold path bumps `kbVersion` (or deletes the key) when `upsertKnowledge` completes, so the next turn re-fetches. Versioned key = no explicit purge race. `moderate`
- Idle client = **zero** requests (no polling — `CLAUDE.md` §NO POLLING respected; this is pull-on-turn + push-invalidate). `high`
- `search` results are **not** cached in v1 (query-dependent, low hit rate). Revisit with a semantic answer cache later. `low`

### Architecture at a glance

```
                         ┌───────────────── Krispy Cloud control-plane (Node) ──────────────┐
 Dashboard KB editor ───▶│ services/memory (Node, own deploy)   ensurePack/upsertKnowledge/export │
 (apps/web)              │   → Factory packs.immorterm.com (build→poll→download)             │
                         │   → R2 durable .impack copy                                       │
                         │   → sidecar /api/v1/packs/import/upload                            │
                         │   → bump kbVersion (invalidate KV RAM cache) + edge entitlement    │
                         └───────────────────────────────────────────────────────────────────┘
                                                     │ (managed) auth boundary in front (§6)
 visitor ──POST /api/chat──▶ CF Worker (edge) ───────┼─────────────────────────────────────────
    per turn (HOT):                                  ▼
      tenantPack(tenantId)  ── KV RAM cache ──▶ (miss) ImmorTerm sidecar  GET /packs/ram
      knowledge.search(pack, msg) ────────────────────────────────────── POST /packs/search
      buildSystemPrompt(tenant.systemPrompt, {ram, hits}) → deps.ai()  (all timeout+graceful-empty)
```

---

## 4. Per-tenant pack lifecycle

### Naming (pack handles must match `^[a-z0-9][a-z0-9-]{1,63}$` — `public-api.md:197`, `high`)

| Purpose | Handle | Notes |
|---|---|---|
| Tenant KB | `tenant-<tenantId>-kb` | one KB pack per tenant. |
| Visitor memory | `visitor-<tenantId>-<visitorId>` | per-visitor cross-session digest (mirrors Delulus `user-<userId>-discovery-memory`, `founder-memory.ts:52`, `high`). |

**Constraint to verify:** `tenantId`/`visitorId` must be slug-safe (lowercase, `[a-z0-9-]`, combined ≤ 64 chars). Krispy's `tenantId` is a KV-key string today (`store.ts:9 kTenant`); Cloud tenant ids and visitor session ids **may exceed 64 chars or contain uppercase** → **hash or truncate** to fit the regex. `moderate` → **open question Q3**.

### Operations (all via the `Knowledge` interface → §3.4 cold path)

- **Create** — dashboard "Knowledge" tab → `ensurePack` + `upsertKnowledge` (Factory `POST /api/packs`, `mode=structured` for uploaded markdown/docs, or `raw` for pasted FAQ text — `public-api.md:198-201`, `high`).
- **Update** — re-save → `upsertKnowledge` → `POST /api/packs/:name/sources` (incremental) or `rebuild` (full). Content-hash dedup means double-clicks are safe (`public-api.md:568-580`, `high`).
- **Export** — "Download my knowledge" → `exportPack` → `.impack` bytes. **This is the data-ownership proof** for the "no lock-in" brand — the tenant walks away with a portable file. `high`
- **Import** — reverse: upload an `.impack` to seed a pack (sidecar `/api/v1/packs/import/upload`). `high`

### The `tenantId` seam (where it ties in)

Krispy already threads `tenantId` end-to-end: `getTenant(env, tenantId)` (config), `meter(env, tenantId, …)` (usage), `entitled(env, tenantId)` (billing) — all keyed on it (`store.ts`, `high`). The KB pack is one more per-tenant resource on the **same seam**: add a `kbPack?`/`kbVersion?`/`knowledgeEnabled?` field to `TenantConfig` (written by the dashboard via the existing guarded `POST /api/tenant/config` merge — `edge/README.md:56-63`, `high`). The Worker derives the pack handle from `tenantId` (§6) — it never trusts a client-supplied pack name.

---

## 5. Retrieval flow per turn (precise sequence)

Where it slots into `chatFlow` (`chat.ts:67-115`, `high`). `chatFlow` already: mirrors to owner topic → checks handoff → applies the **sliding window** (`chat.ts:88`) → builds `messages: [system, ...windowed, user]` (`chat.ts:89-93`) → `deps.ai(messages)`. Knowledge slots in at the **system-prompt build**, before `deps.ai`:

```
1. Worker /api/chat handler (index.ts:107-126) resolves tenantId, entitlement, tenant config.  [today]
2. NEW: pack = deriveTenantPack(tenantId); if knowledgeEnabled:
     ram  = ramCacheOrFetch(pack)                 // KV first, sidecar on miss (400ms timeout)
     hits = knowledge.search(pack, message, {limit:3, 600ms})   // parallel with ram
     (Promise.all — mirrors Delulus's parallel getPackRam+searchPack, chat.ts:637-653)
3. systemPrompt = buildSystemPrompt(tenant.systemPrompt, { ram, hits })
     static half:  [voice/handoff contract] + ["## Knowledge base summary\n" + ram]   ← cacheable
     dynamic half: ["## Relevant to this question\n" + hits.map(...)]                   ← per-turn
4. chatFlow(deps{ systemPrompt, history }, { sessionId, message })    // unchanged signature
5. Inside chatFlow: sliding window over history + [system, ...windowed, user] → deps.ai   [today]
```

**Composition rules:**
- RAM sits in the **static** block so it composes with prompt caching (provider-side when BYO-key; KV-side on Workers AI). `high`
- `search` hits sit in the **dynamic** block (they change every turn). Cap `limit=3` for v1 (Delulus defaults 5, `chat.ts:480`; smaller = cheaper for chat). `moderate`
- The sliding window is **unchanged** — knowledge is prompt-prefix context, not history. The two are orthogonal; the window still bounds the *conversation* tail (`chat.ts:88`, `high`).
- Empty ram/hits → the blocks are simply omitted (same null-safe contract as Delulus's `formatFounderMemoryBlock` → `""` on empty, `founder-memory.ts:108-118`, `high`). The bot degrades to today's behavior.

**Visitor memory (async, off the hot path):**
- On session start / first turn: `recallVisitor(tenantId, visitorId)` → prepend a "what we know about this visitor" block (Delulus `founder-memory.ts:108`, `high`). Same timeout+graceful-empty.
- After a resolved session (or on handoff/close): `rememberVisitor(...)` **fire-and-forget** — never blocks the reply, never throws (`founder-memory.ts:127` contract, `high`). Snapshot content = a short LLM-summarized digest of the session (v1 could just store the transcript tail; summarization is a follow-up). `low`

---

## 6. The auth / tenant-isolation boundary (the real work)

**The sidecar and Factory ship NO AUTH today** — "BOTH ship NO AUTH today — the consumer owns the auth boundary" (research brief; confirmed: `public-api.md:80` Factory auth = "None today", and the sidecar binds `127.0.0.1` by default, `high`). This is the single most important engineering task in this doc: **a raw sidecar exposed to the internet is a total-KB-leak vulnerability** — anyone who can reach it can read/delete any pack (`delete_pack` exists, `packs.rs:116`, `high`).

### The threat

`POST /api/v1/packs/search {pack_name, query}` takes an **arbitrary** `pack_name`. If the Worker forwarded a client-supplied pack name, tenant A could read tenant B's KB by guessing `tenant-<B>-kb`. **Mitigation is non-negotiable:**

### The boundary (defense in depth)

1. **Network: never expose the sidecar publicly.** Put it behind **Cloudflare Tunnel + Cloudflare Access** (service-token auth) or on a private network only the Worker/Node service can reach. The sidecar's default `127.0.0.1` bind (`high`) is the starting posture; the tunnel gives the Worker a reachable-but-authenticated URL. A service token (`CF-Access-Client-Id`/`Secret` headers, injected by the Worker from secrets) authenticates *Krispy* to the sidecar. `moderate`
2. **Application: the Worker owns the tenant→pack mapping. NEVER trust the client.** The pack handle is **derived server-side** from the authenticated `tenantId`:
   ```ts
   function deriveTenantPack(tenantId: string) {
     return `tenant-${slugSafe(tenantId)}-kb`;   // client never supplies a pack name
   }
   ```
   The `/api/chat` body's `tenantId` is itself resolved through the existing entitlement gate (`entitled(env, tenantId)`, `index.ts:112`, `high`) before any knowledge call. A tenant can therefore **only ever touch its own pack** — there is no code path that lets a request name another tenant's pack. `high` (this is the core invariant).
3. **Cloud multi-tenancy: one sidecar, many packs, mapping enforced at the edge.** Since isolation is enforced by the Worker-derived handle (not by the sidecar, which has none), the security property holds even on a shared managed sidecar. Per-tenant sidecar instances are a *heavier* option if a tenant demands hard isolation (Cloud enterprise tier) — `low`, not v1.
4. **Visitor packs: same rule.** `visitor-<tenantId>-<visitorId>` is derived from the authenticated tenant + the session-bound visitor id (Krispy already binds `sessionId`↔tenant in KV, `store.ts:70-97`, `high`). A visitor can't name another visitor's pack.

**Security invariant (must hold):** *every* pack handle used in a sidecar/Factory call is derived from server-side-authenticated identity; **no request field ever supplies a pack name.** A test must assert this (a `/api/chat` with a forged `pack`/`pack_name` field has no effect). `high`

---

## 7. Config, plan/size gate, latency, failure modes

### Config / env (no hardcoded URLs — `CLAUDE.md` §2, `high`)

| Var | Default | Meaning |
|---|---|---|
| `KNOWLEDGE_PROVIDER` | `none` | `none` → null adapter; `immorterm` → ImmorTerm adapter. |
| `IMMORTERM_MEMORY_URL` | `""` | Sidecar base (behind the tunnel). Empty ⇒ null adapter regardless of provider. |
| `IMMORTERM_PACKS_URL` | `""` | Factory base. Empty ⇒ cold builds disabled (hot path can still read an imported pack). |
| `IMMORTERM_ACCESS_CLIENT_ID/SECRET` | `""` | CF Access service-token creds the Worker injects (§6). |
| `KNOWLEDGE_RAM_TTL_S` | `300` | KV RAM cache TTL. |
| `KNOWLEDGE_SEARCH_LIMIT` | `3` | top-K per turn. |
| `KNOWLEDGE_RAM_TIMEOUT_MS` / `_SEARCH_TIMEOUT_MS` | `400` / `600` | hot-path AbortSignal budgets. |

All follow the existing pattern (edge reads env for the turn-tax knobs — `edge/README.md:43-49`, `high`).

### Plan + size gate

Two gates compose:

1. **Entitlement gate (exists).** `entitled(env, tenantId)` already fails-closed for un-subscribed Cloud tenants and is unmetered for `self` (`store.ts:193`, `high`). Knowledge for Cloud tenants rides this — a Cloud "Knowledge" add-on flips `knowledgeEnabled` in the entitlement snapshot. `self` is always allowed. `moderate`
2. **Size gate (new, per-tenant).** Retrieval only pays for itself above a KB size threshold:
   | KB size | Strategy | Why |
   |---|---|---|
   | **Small** (≤ ~1 RAM-worth, ~20K chars) | Inline the whole KB into the cacheable prefix **once**, cache in KV. **No `search` per turn.** | The KB *is* the RAM; a per-turn search RTT buys nothing. `moderate` |
   | **Large** (> threshold) | Pack + RAM prefix + per-turn top-K `search`. | The whole KB won't fit the cacheable budget; retrieval is the point. `moderate` |
   | **Cloud tier** | Managed sidecar + Factory; higher size caps + visitor memory. | The paid value-add. `moderate` |

   The gate is a `size`-vs-threshold check the cold path records on the tenant record (Factory returns pack `size`, `public-api.md:391`, `high`).

### Latency mitigation

- KV RAM cache (§3.5) removes the sidecar RTT on the hot read for cache hits (KV read ≈ sub-ms at edge). `high`
- RAM + search run **in parallel** (`Promise.all`, Delulus pattern `chat.ts:637`, `high`).
- Tight AbortSignal budgets (400/600 ms) + graceful-empty → a slow sidecar degrades to *no context*, never a slow turn. `high`
- Co-locate the managed sidecar near the Worker's origin pull region to bound RTT. `low`.

### Failure modes / graceful degradation (the load-bearing guarantee)

| Failure | Behavior | Source |
|---|---|---|
| Sidecar down / slow | `getRam`→`""`, `search`→`[]` (timeout+catch). **Chat answers normally, no knowledge.** | Delulus contract, `founder-memory.ts:83-93`, `high` |
| Factory down (cold) | Build fails; pack status `error`; existing imported pack still serves reads. Dashboard shows "update failed, retry." | `knowledge.ts:162-173`, `high` |
| Pack not yet built / empty | `""`/`[]` → today's behavior. | `high` |
| KV cache miss | Fetch sidecar, repopulate. | `high` |
| `KNOWLEDGE_PROVIDER=none` | Null adapter — no network, no deps. | decision #1, `high` |
| Visitor-memory write fails | Swallowed (fire-and-forget); reply already sent. | `founder-memory.ts:127`, `high` |

**Invariant:** memory is *always* additive. Its absence, slowness, or failure can only ever remove context — never break, block, or slow a turn. This mirrors Krispy's existing "AI down → still hand off, never drop the visitor" ethos (`chat.ts:102-106`, `high`).

---

## 8. Build phases + effort + risks

Effort in ideal-dev-days, `moderate` confidence unless noted. Krispy's "≤3 files per task" rule (`CLAUDE.md` working-together #3) means each phase is several small PRs.

| # | Phase | Scope | Effort | Confidence |
|---|---|---|---|---|
| 1 | **Interface + null adapter** | `libs/knowledge` barrel: `Knowledge` iface + `NullKnowledge`. Wire into `index.ts`/`chatFlow` deps behind `KNOWLEDGE_PROVIDER`. No behavior change yet. | 0.5–1 d | `high` (pure port of a seam that already exists) |
| 2 | **Edge hot helpers** | `getRam`/`search` in `ImmortermKnowledge` (port `chat.ts:476-527`), `buildSystemPrompt` 2nd arg, timeout+graceful-empty, unit tests. | 1–2 d | `high` |
| 3 | **KV RAM cache** | versioned key, TTL, invalidate hook. | 0.5–1 d | `high` |
| 4 | **Auth / tenant-isolation boundary** | CF Tunnel+Access in front of sidecar; service-token injection; `deriveTenantPack`; the "no client pack name" test. **The real work.** | 2–4 d | `moderate` (infra + security) |
| 5 | **Node cold lifecycle** | `ensurePack/upsertKnowledge/export` in a new `services/memory` (port `knowledge.ts`), R2 durable copy, Factory poll loop, dashboard endpoint. | 3–5 d | `moderate` |
| 6 | **Dashboard KB editor** | `apps/web` "Knowledge" tab → cold endpoints; size-gate + status UI. | 2–3 d | `moderate` |
| 7 | **Visitor memory** | `remember/recallVisitor`, session snapshot summarizer, recall injection. | 2–3 d | `moderate` |
| 8 | **Cloud sidecar hosting + ops** | Deploy managed ImmorTerm sidecar+Factory, backups, per-tenant provisioning, entitlement wiring. | 3–6 d | `low` (ops-heavy, ImmorTerm-side unknowns) |

**Recommended slice for a first shippable increment:** Phases 1–4 (opt-in, self-hostable, secure KB retrieval on a self-run sidecar). That's the OSS core and the honest "powered by ImmorTerm" story without Krispy Cloud needing to host anything yet.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **No-auth sidecar/Factory** (`high`) | Total KB leak if exposed. | §6 boundary is mandatory; ship Phase 4 *before* any public sidecar. The Factory doc itself says design for a future `Authorization: Bearer` header (`public-api.md:83`) — build the header seam now. |
| **Stateful sidecar ops** (`moderate`) | SQLite-on-a-box; loss = KB loss; scaling is vertical. | R2 durable `.impack` copies (re-import cheaply); managed backups (Cloud). |
| **Edge→sidecar RTT** (`moderate`) | Per-turn latency. | KV cache + parallel + tight timeouts (§7). |
| **Factory cost** (`moderate`) | Pack builds are LLM-driven (`public-api.md:38`) → real $ per rebuild. | `structured` mode = "mechanical splitting, zero LLM, dramatically cheaper" for pre-structured MDs (`knowledge.ts:355-362`, `high`) — use it for doc uploads; reserve `digest` (LLM) for PDFs. Dedup + incremental `sources` over full rebuilds. |
| **ImmorTerm API is pre-1.0** (`moderate`) | `public-api.md` has `<!-- TODO: confirm -->` on auth, rate-limits, source shape. | Pin behind the adapter; the interface absorbs churn. |
| **Pack-name regex vs tenant/visitor ids** (`moderate`) | Build fails on non-slug ids. | `slugSafe()` (hash/truncate) — Q3. |

---

## 9. Cross-promotion plan — "powered by ImmorTerm"

ImmorTerm is the founder's own product; surfacing it is an honest ecosystem play, not paid placement.

- **README** — a "Knowledge & Memory" section: "Give your bot your docs and a memory. Powered by [ImmorTerm Memory](https://immorterm.com) — the same engine behind the founder's other products. Self-host it yourself, or let Krispy Cloud run it." Slots beside the existing "self-hostable core" note (`README.md:129`, `high`).
- **This doc + `libs/knowledge` README** — link ImmorTerm's `public-api.md` as the upstream contract.
- **Blog post angle: "We gave our support bots a memory (and open-sourced the seam)."** The arc: (1) the turn-tax problem (quadratic history cost) → (2) why stuffing the whole KB every turn is worse → (3) RAM digest + top-K retrieval as the fix → (4) the open-core play: the adapter is OSS, the hosting is the business → (5) "powered by ImmorTerm," an honest look at building on your own tools. Ties the cost-engineering story (already in `edge/README.md`) to the ecosystem story.
- **Dashboard** — a subtle "Knowledge powered by ImmorTerm" footer on the KB tab (Cloud), reinforcing the managed value-add.
- **Positioning guard:** keep the "own your data / no lock-in" message intact — the `exportPack` "download your .impack" button is the proof, and the null adapter proves Krispy runs without ImmorTerm at all. Cross-promo must never read as lock-in. `high`

---

## Appendix — key source citations

- Krispy edge flow: `services/edge/src/chat.ts` (chatFlow, turn-tax, sliding window), `src/system-prompt.ts` (buildSystemPrompt), `src/store.ts` (tenantId seam, entitled, KV), `src/index.ts` (chat wiring), `README.md` (turn-tax knobs, self-host core).
- Delulus patterns: `services/api/src/lib/founder-memory.ts` (RAM read w/ timeout, fire-and-forget write), `services/api/src/routes/chat.ts:476-707` (getPackRam/searchPack + parallel RAM injection into cacheable prefix), `services/ai-worker/src/pipeline/knowledge.ts` (Factory build→poll→download→R2→import).
- ImmorTerm contracts: `docs/public-api.md` (Factory `packs.immorterm.com`), `services/memory/src/routes/packs.rs` + `routes/mod.rs:87-96` (sidecar `/api/v1/packs/*`: ram, search, import/upload, export/download).
