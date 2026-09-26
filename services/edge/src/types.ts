// Shared types + the tenant seam. Everything is keyed by tenantId (default "self")
// so the single-tenant self-host and a future multi-tenant SaaS are the same code.

// ── Connectors + Lead (Feature A) ─────────────────────────────────────────
export type FieldType = "text" | "email" | "tel" | "textarea" | "select";
export interface FormField {
  name: string; // machine key, e.g. "budget"
  label: string; // visitor-facing
  type: FieldType;
  required?: boolean;
  options?: string[]; // select only
}
export interface FormSpec {
  id: string; // referenced by [!FORM:<id>]
  title: string; // card heading, e.g. "book a call"
  fields: FormField[];
  connectorIds?: string[]; // which connectors receive this lead; default = ALL configured
  successText?: string; // shown in the collapsed card after submit; widget has a default
}
export type ConnectorType =
  | "email"
  | "telegram"
  | "whatsapp"
  | "phone"
  | "instagram"
  | "facebook"
  | "tiktok"
  | "link";
// CTA fields — the code already treats connectors as dual-purpose (delivery AND
// visitor-facing CTA cards). These live on the connector rather than a parallel ctas[]
// list. Inert on delivery-only types (email/telegram); the projection fills per-type
// defaults for the CTA-capable ones.
export interface CtaFields {
  cta?: boolean; // default true for CTA-capable types — false keeps a connector
  // delivery-only (e.g. a whatsapp wired into form.connectorIds but never shown as a CTA)
  label?: string; // button label; projection fills a per-type default when unset
  caption?: string; // small text above the button ("or keep chatting here")
  showAfterMs?: number; // per-CTA stagger after the FIRST visitor message. Default 0.
}
export interface Connector extends CtaFields {
  id: string;
  type: ConnectorType;
  toAddress?: string; // email
  phone?: string; // whatsapp/phone (digits, no +)
  profileUrl?: string; // instagram
  url?: string; // facebook/tiktok/link (https)
  // telegram uses the existing top-level botToken/chatId — no per-connector creds
}

// ── Widget theme (Feature B) ──────────────────────────────────────────────
export interface WidgetTheme {
  launcherStyle?: "circle" | "pill"; // default circle; pill shows a short label while closed
  launcherLabel?: string; // pill text; widget trims to 24 characters, defaults to header title
  primaryColor?: string; // header + visitor bubble + send button. Default gold #e39a2b
  launcherColor?: string; // optional mascot badge fill; unset/"transparent" keeps Buttr floating
  glowColor?: string; // hex → drives glow/sparkle/pulse rgba stops. UNSET = no glow
  // layer at all (default) — the launcher keeps today's neutral look
  position?: "br" | "bl"; // bottom-right | bottom-left. Default "br"
  avatar?: string; // "buttr" (default) | "none" | https URL | data:image/… URI
  greeting?: string; // first bot bubble on open
  headerTitle?: string; // header text (supersedes legacy data-title)
  tagline?: string; // header sub-line ("usually replies in minutes")
  radius?: number; // panel/bubble corner radius px, 0–20. Default 14
  font?: string; // optional CSS font-family stack
  sound?: boolean; // notification ding on inbound message while panel closed. Default true
  sparkle?: boolean; // idle sparkle loop on the launcher. Default false.
  direction?: "ltr" | "rtl"; // flips bubble corners, input dir, mirrors send icon. Default "ltr".
  popupText?: string; // proactive popup copy. Unset = popup off. NOT the greeting —
  // greeting is the first bot bubble; popupText is the teaser card.
  timing?: WidgetTiming;
}

export interface WidgetTiming {
  // all ms; widget clamps 0–300_000. Defaults are field-proven UX values — each takes
  // effect only when the feature it belongs to is enabled; none changes the default
  // widget on its own.
  launcherDelayMs?: number; // default 0 = no delay
  sparkleAfterMs?: number; // default 10000; inert unless theme.sparkle
  popupDelayMs?: number; // default 8000; inert unless theme.popupText
  popupCooldownHrs?: number; // default 24; inert unless theme.popupText
  autoOpenMs?: number; // default 0 = never — auto-open panel after inbound msg while closed (field-proven: 2000)
}

// ── Persona + conversation script (Feature B) ─────────────────────────────
// Two halves of "the bot sounds like OUR shop": how it SPEAKS (server-side, folded
// into the system prompt, NEVER projected) and how a conversation STARTS (widget-side,
// projected via publicWidgetConfig). All fields default unset — the bot behaves exactly
// as today until the tenant writes persona/script.
export interface PersonaSpec {
  // → buildSystemPrompt() only; structurally excluded from the public boot config
  toneOfVoice?: string; // free text: "warm, playful boulangerie owner; short sentences"
  styleRules?: string[]; // discrete do/don't rules: "never discuss competitors"
}
export interface ConversationScript {
  // → publicWidgetConfig() + widget boot render
  opening?: string[]; // scripted bot-bubble sequence on panel open; opening[0] supersedes
  // theme.greeting (greeting alone == opening of length 1). Projection caps at 5.
  starters?: string[]; // suggested-question chips above the input on a FRESH conversation;
  // click sends the text as the visitor's message. Projection caps at 4.
}

// ── Popup engine (Feature B) — one engine for timed AND section-proximity popups ──
// Each entry renders a teaser card above the launcher. theme.popupText is sugar for a
// single timer popup. Default: no popups configured = nothing ever shows.
export interface PopupSpec {
  trigger:
    | { kind: "timer"; delayMs?: number } // default 8000
    | { kind: "near"; selector: string; dwellMs?: number; threshold?: number }; // 8000 / 0.3
  text: string; // the suggestive message (teaser card copy)
  persist?: boolean; // default true → cooldownHours applies; false = resets every load
  cooldownHours?: number; // default 24; per-popup localStorage key (source ?? index)
  cancelOnClick?: string; // selector — visitor clicked the thing itself → dismiss popup
  source?: string; // origin label ("popup_pricing"); rides session context → handoff/lead meta
}

// ── Kbase source registry + relearning (Feature B) ─────────────────────────
// A per-doc knowledge registry (kills the "one melted string" prompt) assembled into
// the system prompt at chat time. Relearning: an operator answer the bot couldn't give
// is extracted into a KbSuggestion (its OWN KV key, never the config blob) for a human
// to approve into kbSources. All default unset — a tenant with neither behaves as today.
export interface KbSource {
  id: string;
  name: string; // human label / doc title, e.g. "Refund policy"
  text: string; // the knowledge body
  updatedAt: number;
}
export interface KbSuggestion {
  id: string;
  question: string; // what the bot couldn't answer
  answer: string; // what the human said
  createdAt: number;
}

export interface TenantConfig {
  /** Audio calls are opt-in; visitor requests can be limited to human handoff. */
  callSettings?: {
    enabled?: boolean;
    visitorRequestsEnabled?: boolean;
    visitorRequestTrigger?: "after_handoff" | "always";
    notifyOnVisitorRequest?: boolean;
  };
  /** Telegram bot token (BotFather). Optional for app-only Cloud tenants. */
  botToken?: string;
  /** Target supergroup id WITH topics enabled. Optional for app-only Cloud tenants. */
  chatId?: string;
  /** Optional system-prompt override. */
  systemPrompt?: string;
  /** Optional model override. */
  model?: string;
  /** Onboarding progress (mirrors cloud types; optional). */
  onboardingStep?: number;
  onboardingComplete?: boolean;
  /** Feature A — lead forms. */
  forms?: FormSpec[];
  /** Feature A — delivery/CTA connectors. */
  connectors?: Connector[];
  /** Feature B — widget appearance. */
  theme?: WidgetTheme;
  /** Feature B — bot voice + style rules. SERVER-ONLY: folded into buildSystemPrompt,
   * NEVER projected to the public widget config (it's instruction text). */
  persona?: PersonaSpec;
  /** Feature B — scripted opening sequence + starter chips (projected to the widget). */
  script?: ConversationScript;
  /** Feature B — proactive popup engine (timer + section-proximity); theme.popupText
   * is sugar for a single timer popup. */
  popups?: PopupSpec[];
  /** Feature B — per-doc knowledge registry, assembled into the system prompt at chat
   * time (buildSystemPrompt). Total text hard-capped at KB_SOURCES_MAX_CHARS on write. */
  kbSources?: KbSource[];
  /** Feature B — bumped on any kbSources write; the retrieval cache key
   * (ram:${tenantId}:${kbVersion}) the size-gated Phase-6 design expects. */
  kbVersion?: number;
  /** Quiet-ops — operators to @mention on handoff. Auto-learned from topic replies
   * (see upsertOperator). SECRET-ADJACENT: never expose to the public widget config. */
  operators?: Operator[];
}

// ── Quiet ops (handoff mention) ───────────────────────────────────────────
// A human the bot can tag when a conversation needs a person. `id` is the Telegram
// user id — enough for a `text_mention` entity, so tagging works even for users with
// no public @username. `username` (if set) is preferred (a plain @mention, no entity).
export interface Operator {
  id: number;
  name?: string;
  username?: string;
  /** Which channel this operator works from. Absent = 'telegram' (back-compat —
   * every pre-existing KV row has no channel). 'app' operators are skipped by the
   * Telegram @mention path so they aren't double-pinged (push + mention). */
  channel?: "telegram" | "app";
}

export interface Env {
  // --- bindings (wrangler.toml) ---
  AI: Ai;
  SESSION: DurableObjectNamespace;
  /** Tenant-scoped, gated 0.5 call owner; SessionDO remains owner of legacy calls. */
  CALL_COORDINATOR?: DurableObjectNamespace;
  KRISPY_KV: KVNamespace;

  // --- single-tenant "self" config (secrets) ---
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Shared secret echoed by Telegram in X-Telegram-Bot-Api-Secret-Token. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  SYSTEM_PROMPT?: string;
  AI_MODEL?: string;
  /** Server-only Gemini API key for the exact KNOWLEDGE_TENANT_ID/SITE_ID pilot. */
  GEMINI_API_KEY?: string;
  // --- turn-tax cost knobs (all optional; sensible defaults in code) ---
  /** Sliding-window size the AI sees, default MAX_HISTORY_MSGS (8). */
  MAX_HISTORY_MSGS?: string;
  /** AI turns before forced human handoff, default MAX_AI_TURNS (10). */
  MAX_AI_TURNS?: string;
  /** Output token cap per reply, default MAX_OUTPUT_TOKENS (256). */
  MAX_OUTPUT_TOKENS?: string;
  /** Preview-only stage timing logs for diagnosing slow chat replies. */
  CHAT_TIMING_DEBUG?: string;
  /** Operator-silence minutes before a handed-off session hands back to the AI,
   * default HANDBACK_SILENCE_MINUTES (5). */
  HANDBACK_SILENCE_MINUTES?: string;
  /** Hours without a live visitor turn before a bot-only session is archived (default 24). */
  AUTO_ARCHIVE_HOURS?: string;

  // --- misc ---
  /** CORS allow-origin for the widget. Default "*". Accepts a comma-separated
   * list ("https://app.example.com,https://example.com"): the request's own
   * Origin is echoed back when it matches an entry (the CORS header can only
   * carry one origin), the first entry otherwise. */
  ALLOWED_ORIGIN?: string;
  /** Optional private retrieval gateway. Never projected to widget config. */
  KNOWLEDGE_GATEWAY_URL?: string;
  /** Server-only bearer credential for the retrieval gateway. */
  KNOWLEDGE_GATEWAY_SECRET?: string;
  /** Exact pilot tenant binding; mismatches disable retrieval. */
  KNOWLEDGE_TENANT_ID?: string;
  /** Exact pilot site binding; empty means the default site. */
  KNOWLEDGE_SITE_ID?: string;
  /** Retrieval deadline in milliseconds, default 250. */
  KNOWLEDGE_TIMEOUT_MS?: string;
  /** Shared secret guarding POST /api/billing/entitlement (billing → gate push). */
  BILLING_SYNC_SECRET?: string;
  /** Shared secret guarding GET /internal/usage (Krispy Cloud admin → per-tenant KV
   *  usage counters for the founder cost view). Unset → the endpoint fails closed (403):
   *  the counters carry no auth of their own, so they never read without this secret. */
  ADMIN_USAGE_SECRET?: string;
  /** Shared secret guarding /api/tenant/config (dashboard → tenant-config sync).
   * ALSO accepted on /api/operator/* as the server-to-server credential
   * (x-tenant-sync-secret — see operator-auth.ts). */
  TENANT_SYNC_SECRET?: string;
  /** Origin of the cloud API that verifies operator bearers (GET /me), e.g.
   * https://api.krispyai.com. Unset → operator bearer auth fails closed (a
   * self-host without the operator app doesn't need it). Var, not secret. */
  API_ORIGIN?: string;
  /** Shared secret the Worker attaches to internal Worker→SessionDO calls (rotatable;
   * a build-time default is used when unset — DOs aren't publicly addressable). */
  DO_INTERNAL_SECRET?: string;
  /** Optional self-hosted or Cloud LiveKit signaling URL; calls fail closed when absent. */
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  /** Pinned, trusted browser UMD bundle URL for livekit-client; no runtime widget deps. */
  LIVEKIT_CLIENT_URL?: string;
  /** New 0.5 calls are limited to this tenant while enabled; unset means legacy only. */
  NATIVE_CALLS_ENABLED?: string;
  CALL_PILOT_TENANT_ID?: string;
  /** Cloud native-call offer/stop sender, paired with x-push-secret. */
  PUSH_TRIGGER_SECRET?: string;
  /** Tenant-approved non-PII label in native incoming-call presentation. */
  CALL_PUBLIC_LABEL?: string;

  // --- operator-app push (Buttr; optional — unset → pushToApp no-ops) ---
  /** Cloud endpoint returning a tenant's Expo push tokens (see push.ts contract). */
  PUSH_TOKENS_URL?: string;
  /** Shared secret sent as x-push-tokens-secret on the token fetch. */
  PUSH_TOKENS_SECRET?: string;

  // --- lead email (Feature A; optional — no key → email delivery no-ops) ---
  /** Resend API key for lead-email delivery (reuses the cloud's existing key). */
  RESEND_API_KEY?: string;
  /** Verified-domain from-address for lead email. */
  LEAD_EMAIL_FROM?: string;
  /** Optional HTTPS inbox URL for the lead email's Open in Buttr action. */
  BUTTR_INBOX_URL?: string;
  /** Public HTTPS origin serving /brand/buttr-chill.png in lead emails. */
  EMAIL_ASSET_ORIGIN?: string;
}

/** Strongly-consistent owner of the next reply for one chat session. */
export type HandoffState = "ai" | "pending" | "operator";

/** A safe, resolved snapshot of a configured item sent by a human operator. */
export type OperatorAction =
  | { kind: "form"; form: Pick<FormSpec, "id" | "title" | "fields" | "successText"> }
  | {
      kind: "instagram";
      connector: { id: string; type: "instagram"; label: string; caption?: string; url: string };
    };

export interface SessionMessage {
  role: "visitor" | "ai" | "operator";
  text: string;
  ts: number;
  action?: OperatorAction;
  lead?: LeadSubmission;
}

/** Form fields retained by the tenant-scoped session, separate from the short chat ring. */
export interface LeadSubmission {
  id: string;
  tenantId: string;
  sessionId: string;
  siteId: string;
  formId: string;
  title: string;
  fields: { name: string; label: string; value: string }[];
  ts: number;
}

/** Message pushed over the DO WebSocket to the visitor's browser. */
export type ServerEvent =
  | { type: "call"; call: ReturnType<typeof import("./call").publicCall>; nonce?: string }
  | {
      type: "ready";
      handoffState: HandoffState;
      handedOff: boolean;
      /** Authoritative ring snapshot for clients reconnecting after backgrounding. */
      messages?: SessionMessage[];
    }
  | { type: "operator"; handoffState: "operator"; text: string; ts: number }
  | { type: "action"; handoffState: "operator"; text: string; ts: number; action: OperatorAction }
  | { type: "lead"; message: SessionMessage }
  | { type: "call_receipt"; receipt: import("./call-coordinator-model").CallTimelineReceipt }
  | { type: "handoff"; handoffState: "pending" | "operator" }
  /** The AI took the session back (operator resolved it, or went silent past the
   * HANDBACK_SILENCE_MINUTES alarm). Widget drops its "human joined" framing. */
  | { type: "resume"; handoffState: "ai" }
  /** Live visitor/AI ring-append mirrored to `role=operator` sockets only (Buttr thread, §3d/§6). */
  | { type: "message"; role: "visitor" | "ai"; text: string; ts: number };
