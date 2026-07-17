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
// (ALLOWED_ORIGIN, API_ORIGIN, AI_MODEL, …) stay in wrangler.toml [vars] — not here.
const EDGE_SECRET_KEYS = [
  "ADMIN_USAGE_SECRET",
  "AI_API_KEY",
  "BILLING_SYNC_SECRET",
  "DO_INTERNAL_SECRET",
  "PUSH_TOKENS_SECRET",
  "RESEND_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "TENANT_SYNC_SECRET",
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
console.log(`✔ edge secret sync complete (${ENV}).`);
