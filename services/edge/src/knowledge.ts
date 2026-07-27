// The Knowledge seam — the tenant's KB, RETRIEVED per turn instead of stuffed into
// every prompt.
//
// Why retrieval at all. Krispy's chat cost is already quadratic in conversation length:
// the widget re-sends the whole history each turn (chat.ts:14), and the turn-tax guards
// (MAX_HISTORY_MSGS=8, MAX_AI_TURNS=10, MAX_OUTPUT_TOKENS) bound only the HISTORY half of
// the input. Pasting a whole knowledge base into every turn puts the unbounded half right
// back — a 50K-char KB is ~12.5K tokens re-billed on every single message. Instead: a
// stable, pre-baked ~20K-char digest ("RAM") as the system-prompt prefix, plus a small
// per-turn top-K. The digest doesn't change between turns; only the top-K does.
//
// Why a seam and not a client. Krispy's promise is "own your data, no lock-in" (README),
// so the chat flow depends on the `Knowledge` interface below and NEVER on a vendor. The
// ImmorTerm adapter is the blessed default; a pgvector/Pinecone adapter is a drop-in; the
// null adapter is what a self-hoster who never opts in gets — no network, no dependency,
// today's bot byte for byte.
//
// HOT PATH ONLY, deliberately. The full interface has a cold half (ensurePack /
// upsertKnowledge / exportPack) that BUILDS packs — multi-minute, LLM-driven, poll-looped —
// which cannot run inside a Worker at all, and a visitor-memory half (rememberVisitor /
// recallVisitor). Both land with the Node service that owns their runtime. Shipping them
// here as no-ops would be dead flexibility, so this file declares exactly the two methods
// the edge turn actually calls.
//
// SECURITY INVARIANT (non-negotiable). Every pack handle is DERIVED from the
// server-side-authenticated tenant — no request field ever supplies a pack name. The
// sidecar ships no auth of its own and `search` takes an arbitrary `pack_name`, so
// forwarding a client-supplied one would let tenant A read tenant B's entire knowledge
// base. See tenantPack() and the test that asserts a forged body field changes nothing.
import { kRam, ns } from "./store";
import type { Env, TenantConfig } from "./types";

/** One retrieved chunk. `score` is the provider's similarity, higher = closer. */
export interface Snippet {
  text: string;
  score: number;
}

/**
 * The seam. Both methods are TOTAL: they resolve to empty on a miss, a timeout, a bad
 * response, or a dead provider — never throw, never reject. That contract is what lets
 * the chat path call them unguarded, and it is why the return types have no error arm.
 */
export interface Knowledge {
  /** Pre-baked digest for the cacheable system-prompt prefix. "" on miss/timeout. */
  getRam(pack: string, opts?: { signal?: AbortSignal }): Promise<string>;
  /** Top-K semantic retrieval for this turn. [] on miss/timeout. */
  search(
    pack: string,
    query: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ): Promise<Snippet[]>;
}

/** The DEFAULT. No opt-in → no network, no dependency, no behavior change whatsoever. */
export const nullKnowledge: Knowledge = {
  getRam: () => Promise.resolve(""),
  search: () => Promise.resolve([]),
};

// ── hot-path budgets (env-overridable, same posture as the turn-tax knobs) ────
// Tight on purpose: a slow provider must degrade to NO CONTEXT, never to a slow turn.
// A self-hoster whose sidecar sits further from their Worker raises these; one running it
// next door lowers them.
export const RAM_TIMEOUT_MS = 400;
export const SEARCH_TIMEOUT_MS = 600;
/** Top-K per turn. 3 keeps the dynamic half of the prompt small — this is a support chat
 * answering one question, not a research agent assembling a report. */
export const SEARCH_LIMIT = 3;
/** RAM cache TTL. A backstop for a missed kbVersion bump, not the primary invalidation. */
export const RAM_TTL_S = 300;

const num = (v: string | undefined, fallback: number): number => Number(v) || fallback;

/**
 * CF Access service-token headers. The sidecar ships NO AUTH of its own, so it must never
 * be publicly reachable: put it behind Cloudflare Tunnel + Access and let the Worker
 * authenticate with a service token. Unset → no headers, which is the correct posture for
 * a sidecar on a private network the Worker already reaches directly.
 */
function accessHeaders(env: Env): Record<string, string> {
  const id = env.IMMORTERM_ACCESS_CLIENT_ID;
  const secret = env.IMMORTERM_ACCESS_CLIENT_SECRET;
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
}

/**
 * The ImmorTerm adapter — a plain `fetch` client against the sidecar's `/api/v1/packs/*`.
 * Both calls swallow every failure by contract (see `Knowledge`): a 404 for a pack that
 * was never built, a timeout, malformed JSON and a sidecar that is simply down all land in
 * the same place — empty context, and the bot answers from its system prompt like it did
 * before anyone turned this on.
 */
export function immortermKnowledge(env: Env): Knowledge {
  const base = (env.IMMORTERM_MEMORY_URL ?? "").replace(/\/+$/, "");
  const headers = accessHeaders(env);
  return {
    async getRam(pack, opts) {
      try {
        const res = await fetch(`${base}/api/v1/packs/ram?pack_name=${encodeURIComponent(pack)}`, {
          headers,
          signal: opts?.signal,
        });
        if (!res.ok) return "";
        // The sidecar returns { ram }, but older builds answered with a bare string.
        const data = (await res.json()) as { ram?: string } | string;
        return (typeof data === "string" ? data : (data?.ram ?? "")).trim();
      } catch (e) {
        console.warn("knowledge: RAM read failed — answering without the digest:", e);
        return "";
      }
    },
    async search(pack, query, opts) {
      try {
        const res = await fetch(`${base}/api/v1/packs/search`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ pack_name: pack, query, limit: opts?.limit ?? SEARCH_LIMIT }),
          signal: opts?.signal,
        });
        if (!res.ok) return [];
        const data = (await res.json()) as {
          results?: { content?: string; text?: string; score?: number }[];
        };
        return (data?.results ?? [])
          .map((r) => ({ text: (r.content ?? r.text ?? "").trim(), score: r.score ?? 0 }))
          .filter((s) => s.text.length > 0);
      } catch (e) {
        console.warn("knowledge: search failed — answering without retrieved context:", e);
        return [];
      }
    },
  };
}

/**
 * Is a knowledge provider configured at all? TWO independent off-switches, both defaulting
 * to off — the provider flag and the sidecar URL. This is the explicit, readable check the
 * whole feature hangs on; it is deliberately NOT a try/catch around a missing binding.
 */
export function knowledgeConfigured(env: Env): boolean {
  return env.KNOWLEDGE_PROVIDER === "immorterm" && Boolean(env.IMMORTERM_MEMORY_URL);
}

/** Pick the adapter for this Worker. Unconfigured → the null adapter, always. */
export function selectKnowledge(env: Env): Knowledge {
  return knowledgeConfigured(env) ? immortermKnowledge(env) : nullKnowledge;
}

/**
 * The pack handle for a (tenant, site) — DERIVED, never supplied by a request.
 *
 * A non-reversible SHA-256 slug, so a handle that leaks into a log or an error message
 * can't be walked back to a customer id, and so any tenant id survives the provider's
 * `^[a-z0-9][a-z0-9-]{1,63}$` handle rule (real tenant ids carry uppercase, `:`, and
 * lengths past 64). 39 chars by construction.
 *
 * Keyed on ns(t, siteId) — one pack per SITE, mirroring the per-site config blob exactly.
 * A default-site tenant hashes the bare tenantId, so the single-site shape is unchanged.
 *
 * ponytail: the cold path stores the reverse tenantId→pack mapping in KV for support
 * lookups when it creates the pack; the hot path never needs it, so it isn't read here.
 */
export async function tenantPack(tenantId: string, siteId?: string): Promise<string> {
  const bytes = new TextEncoder().encode(ns(tenantId, siteId));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `tenant-${hex.slice(0, 32)}`;
}

/**
 * RAM read with the KV cache in front (the digest is stable per KB version, and every turn
 * otherwise pays an edge→sidecar round trip for the same bytes). The cache key carries
 * kbVersion, so a KB write invalidates for free — no purge call, no purge race. The TTL
 * only backstops a bump that never happened.
 *
 * A miss is NOT cached: an empty result means "no pack yet" far more often than it means
 * "provider down", and a newly built pack should go live on the next turn rather than up
 * to RAM_TTL_S later. The cost of that choice is bounded by RAM_TIMEOUT_MS per turn while
 * a provider is genuinely dead.
 */
export async function cachedRam(
  env: Env,
  knowledge: Knowledge,
  pack: string,
  tenantId: string,
  siteId: string | undefined,
  kbVersion: number,
): Promise<string> {
  const key = kRam(tenantId, kbVersion, siteId);
  const hit = await env.KRISPY_KV.get(key);
  if (hit) return hit;
  const ram = await knowledge.getRam(pack, {
    signal: AbortSignal.timeout(num(env.KNOWLEDGE_RAM_TIMEOUT_MS, RAM_TIMEOUT_MS)),
  });
  if (ram) {
    await env.KRISPY_KV.put(key, ram, {
      expirationTtl: num(env.KNOWLEDGE_RAM_TTL_S, RAM_TTL_S),
    });
  }
  return ram;
}

/** What the chat turn injects. Both empty = the prompt is exactly today's. */
export interface RetrievedKnowledge {
  ram: string;
  hits: Snippet[];
}

export const NO_KNOWLEDGE: RetrievedKnowledge = { ram: "", hits: [] };

/**
 * The one call the chat seam makes: derive the pack, then read the digest (KV-cached) and
 * this turn's top-K IN PARALLEL, bounded by their own timeouts.
 *
 * Gated TWICE, both defaulting to off:
 *   1. `knowledgeConfigured(env)` — no provider, no sidecar URL → nothing happens at all.
 *   2. `tenant.knowledgeEnabled` — the SIZE GATE. Below the threshold a KB already fits
 *      the prompt prefix, so kbSources stays inlined exactly as today and a per-turn
 *      search round trip would buy nothing. Above it, the pack is the point.
 *
 * Never throws. The adapters swallow their own failures; this also catches a KV read
 * going wrong, because the whole guarantee of this feature is that its absence, slowness,
 * or failure can only ever REMOVE context — never break, block, or slow a turn.
 */
export async function retrieveKnowledge(
  env: Env,
  tenantId: string,
  siteId: string | undefined,
  tenant: TenantConfig | null,
  message: string,
): Promise<RetrievedKnowledge> {
  if (!tenant?.knowledgeEnabled || !knowledgeConfigured(env)) return NO_KNOWLEDGE;
  try {
    const knowledge = selectKnowledge(env);
    const pack = await tenantPack(tenantId, siteId);
    const [ram, hits] = await Promise.all([
      cachedRam(env, knowledge, pack, tenantId, siteId, tenant.kbVersion ?? 0),
      knowledge.search(pack, message, {
        limit: num(env.KNOWLEDGE_SEARCH_LIMIT, SEARCH_LIMIT),
        signal: AbortSignal.timeout(num(env.KNOWLEDGE_SEARCH_TIMEOUT_MS, SEARCH_TIMEOUT_MS)),
      }),
    ]);
    return { ram, hits };
  } catch (e) {
    console.warn("knowledge: retrieval failed — answering without it:", e);
    return NO_KNOWLEDGE;
  }
}
