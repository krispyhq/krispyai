// Sync the edge Worker's secrets from the Infisical-fed .env.local — the missing half
// of "secrets never go stale on deploy". Deploying a new edge bundle that READS a
// secret the Worker never received fails closed silently (403s / no-ops); this script
// runs as a deploy.sh step so every deploy re-asserts the secrets alongside the code.
//
//   node scripts/sync-edge-secrets.mjs <preview|production> [--dry-run]
//
// Reads ONLY .env.local (never ambient process.env — a stray shell secret must not
// leak into the Worker) and PUTs each known edge secret KEY that has a value onto the
// target Worker via the CF secrets API. Keys absent from .env.local are skipped (the
// edge fails closed per-feature — self-hosters without e.g. Telegram lose only that).
// Values are never printed. Idempotent: a sync is an overwrite from the source of truth.
import { readFileSync } from "node:fs";

const ENV = process.argv[2];
const DRY = process.argv.includes("--dry-run");
if (!["preview", "production"].includes(ENV)) {
  console.error("usage: node scripts/sync-edge-secrets.mjs <preview|production> [--dry-run]");
  process.exit(2);
}

// The edge Env's secret-shaped bindings (src/types.ts). Plain config vars
// (ALLOWED_ORIGIN, API_ORIGIN, AI_MODEL, …) stay in wrangler.toml [vars] — except the
// optional private knowledge gateway settings below, which are intentionally sourced
// from Infisical so a hosted preview can be enabled without hardcoding an endpoint.
const EDGE_SECRET_KEYS = [
  "ADMIN_USAGE_SECRET",
  "AI_API_KEY",
  "BILLING_SYNC_SECRET",
  "DO_INTERNAL_SECRET",
  "KNOWLEDGE_GATEWAY_SECRET",
  "PUSH_TOKENS_SECRET",
  "RESEND_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "TENANT_SYNC_SECRET",
];
const EDGE_KNOWLEDGE_CONFIG_KEYS = [
  "KNOWLEDGE_GATEWAY_URL",
  "KNOWLEDGE_TENANT_ID",
  "KNOWLEDGE_SITE_ID",
  "KNOWLEDGE_TIMEOUT_MS",
];

let raw;
try {
  raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
} catch {
  console.error("✘ .env.local not found — export it from Infisical first (docs/secrets.md).");
  process.exit(1);
}
const L = Object.fromEntries(
  raw
    .split("\n")
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^["']|["']$/g, "")]),
);

const TOKEN = L.CLOUDFLARE_API_TOKEN;
const ACCT = L.CLOUDFLARE_ACCOUNT_ID;
if (!TOKEN || !ACCT) {
  console.error("✘ CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing from .env.local.");
  process.exit(1);
}

const worker = ENV === "production" ? "krispy-edge" : "krispy-edge-preview";
const present = EDGE_SECRET_KEYS.filter((k) => L[k]);
const absent = EDGE_SECRET_KEYS.filter((k) => !L[k]);
const presentKnowledgeConfig = EDGE_KNOWLEDGE_CONFIG_KEYS.filter((k) => L[k]);
const absentKnowledgeConfig = EDGE_KNOWLEDGE_CONFIG_KEYS.filter((k) => !L[k]);

console.log(`→ ${worker}: syncing ${present.length} secret(s)${DRY ? " (dry-run)" : ""}`);
for (const key of present) {
  if (DRY) {
    console.log(`  · ${key} (would PUT)`);
    continue;
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/scripts/${worker}/secrets`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: key, text: L[key], type: "secret_text" }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    console.error(`  ✘ ${key} — CF API ${res.status}`);
    process.exit(1);
  }
  console.log(`  ✔ ${key}`);
}
if (absent.length) console.log(`  ⚠ skipped (absent in .env.local): ${absent.join(", ")}`);
if (DRY) {
  console.log(
    `→ ${worker}: syncing ${presentKnowledgeConfig.length} knowledge config binding(s) (dry-run)`,
  );
  for (const key of presentKnowledgeConfig) console.log(`  · ${key} (would PUT plain_text)`);
  for (const key of absentKnowledgeConfig) console.log(`  · ${key} (would remove / keep disabled)`);
  console.log(`✔ edge secret sync complete (${ENV}).`);
  process.exit(0);
}

// Worker-side vars are version bindings rather than secrets. Read the current binding
// set and merge the optional gateway keys so this sync never drops AI, DO, KV, or other
// wrangler-managed bindings. Missing gateway keys are removed, preserving the default
// disabled state instead of leaving a stale endpoint active after Infisical clears it.
const settingsPath = `/workers/scripts/${worker}/settings`;
const settingsResponse = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCT}${settingsPath}`,
  {
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  },
);
const settingsBody = await settingsResponse.json().catch(() => ({}));
if (!settingsResponse.ok || !settingsBody.success) {
  console.error(`✘ ${worker}: could not read Worker bindings (CF API ${settingsResponse.status})`);
  process.exit(1);
}
const existingBindings = Array.isArray(settingsBody.result?.bindings)
  ? settingsBody.result.bindings
  : [];
const gatewayBindings = new Map(
  presentKnowledgeConfig.map((key) => [key, { name: key, text: L[key], type: "plain_text" }]),
);
const mergedBindings = existingBindings
  .filter((binding) => !EDGE_KNOWLEDGE_CONFIG_KEYS.includes(binding?.name))
  .concat([...gatewayBindings.values()]);
const changedBindings =
  existingBindings.length !== mergedBindings.length ||
  EDGE_KNOWLEDGE_CONFIG_KEYS.some((key) => {
    const before = existingBindings.find((binding) => binding?.name === key)?.text;
    return before !== (L[key] ?? undefined);
  });
console.log(
  `→ ${worker}: syncing ${presentKnowledgeConfig.length} knowledge config binding(s)${DRY ? " (dry-run)" : ""}`,
);
if (changedBindings) {
  const update = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCT}${settingsPath}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bindings: mergedBindings }),
    },
  );
  const updateBody = await update.json().catch(() => ({}));
  if (!update.ok || !updateBody.success) {
    console.error(`✘ ${worker}: knowledge config sync failed (CF API ${update.status})`);
    process.exit(1);
  }
  console.log(
    `  ✔ knowledge config bindings (${presentKnowledgeConfig.length} present, ${absentKnowledgeConfig.length} absent)`,
  );
} else {
  console.log("  ✔ knowledge config bindings already current");
}
console.log(`✔ edge secret sync complete (${ENV}).`);
