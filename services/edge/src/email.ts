// Dependency-free lead email for the self-hostable Worker. The visual language
// mirrors Krispy Cloud's mail shell, while the public core stays independent.
import type { FormSpec } from "./types";

export type FetchLike = typeof fetch;

export interface LeadEmail {
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

const color = {
  cream: "#fbf6ee",
  paper: "#fffdf9",
  ink: "#241a12",
  gold: "#e39a2b",
  muted: "#6b5d4f",
  border: "#eadfcf",
} as const;

/** Escape all visitor-controlled values before inserting them into HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeActionUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function publicEmailAssetUrl(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return undefined;
    return `${url.origin}/brand/buttr-chill.png`;
  } catch {
    return undefined;
  }
}

/** Build a session link without allowing a configured non-web scheme. */
export function leadInboxUrl(baseUrl: string | undefined, sessionId: string): string | undefined {
  const safe = safeActionUrl(baseUrl);
  if (!safe || !sessionId || sessionId.length > 200) return undefined;
  const url = new URL(safe);
  url.searchParams.set("sessionId", sessionId);
  return url.toString();
}

function roleName(role: string): string {
  switch (role.toLowerCase()) {
    case "user":
    case "visitor":
      return "Visitor";
    case "assistant":
    case "ai":
      return "Krispy";
    case "operator":
    case "human":
      return "Your team";
    default:
      return "Message";
  }
}

/**
 * Render contact details and the recent conversation for the form's owner.
 * The optional Buttr URL must target the authenticated inbox for this session.
 */
export function renderLeadEmail(
  form: FormSpec | null,
  values: Record<string, string>,
  transcript: { role: string; content: string }[],
  waPhone?: string,
  openInButtrUrl?: string,
  assetOrigin?: string,
): LeadEmail {
  const title = form?.title || "New lead";
  const labelFor = (name: string) =>
    form?.fields.find((field) => field.name === name)?.label || name;
  const emailField = form?.fields.find((field) => field.type === "email");
  const replyTo = (emailField && values[emailField.name]?.trim()) || undefined;
  const fields = Object.entries(values)
    .filter(([, value]) => value != null && value.trim() !== "")
    .map(([name, value]) => ({ label: labelFor(name), value }));
  const inboxUrl = safeActionUrl(openInButtrUrl);
  const digits = waPhone?.replace(/\D/g, "");
  const whatsAppUrl = digits ? `https://wa.me/${digits}` : undefined;
  const messages = transcript.map((message) => ({
    from: roleName(message.role),
    body: message.content,
  }));
  const mascotUrl = publicEmailAssetUrl(assetOrigin);
  const brandHeader = mascotUrl
    ? `<table role="presentation" style="border-collapse:collapse;width:100%"><tr>` +
      `<td style="font-size:27px;font-weight:900;letter-spacing:-1.5px;vertical-align:middle">krispy<span style="color:${color.gold}">.</span></td>` +
      `<td style="text-align:right;vertical-align:middle;width:64px"><img src="${esc(mascotUrl)}" alt="Buttr, the Krispy croissant mascot" width="58" height="58" style="display:block;margin-left:auto;width:58px;height:58px" /></td>` +
      `</tr></table>`
    : `<p style="font-size:27px;font-weight:900;letter-spacing:-1.5px;margin:0">krispy<span style="color:${color.gold}">.</span></p>`;

  const fieldRows = fields
    .map(
      ({ label, value }) =>
        `<tr><td style="padding:9px 16px 9px 0;vertical-align:top;color:${color.muted};font-size:13px;font-weight:600">${esc(label)}</td>` +
        `<td style="padding:9px 0;vertical-align:top;color:${color.ink};font-size:15px;word-break:break-word">${esc(value)}</td></tr>`,
    )
    .join("");
  const conversation = messages.length
    ? `<h2 style="color:${color.ink};font-size:18px;margin:28px 0 12px">Conversation</h2>` +
      messages
        .map(
          ({ from, body }) =>
            `<p style="border-left:3px solid ${color.border};color:${color.ink};font-size:14px;line-height:1.55;margin:0 0 12px;padding:0 0 0 12px">` +
            `<strong>${esc(from)}</strong><br>${esc(body).replace(/\n/g, "<br>")}</p>`,
        )
        .join("")
    : "";
  const action = inboxUrl
    ? `<p style="margin:26px 0 12px"><a href="${esc(inboxUrl)}" style="background:${color.gold};border-radius:8px;color:${color.ink};display:inline-block;font-size:15px;font-weight:700;padding:13px 22px;text-decoration:none">Open in Buttr</a></p>` +
      `<p style="color:${color.muted};font-size:12px;line-height:1.5;word-break:break-all">Button not working? <a href="${esc(inboxUrl)}">${esc(inboxUrl)}</a></p>`
    : "";
  const whatsApp = whatsAppUrl
    ? `<p style="margin:16px 0 0"><a href="${whatsAppUrl}" style="color:${color.ink};font-size:14px">Reply on WhatsApp</a></p>`
    : "";
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="background:${color.cream};color:${color.ink};font-family:Arial,Helvetica,sans-serif;margin:0;padding:24px 12px">` +
    `<table role="presentation" style="background:${color.paper};border:1px solid ${color.border};border-collapse:collapse;margin:0 auto;max-width:560px;width:100%"><tr><td style="background:${color.gold};height:7px;font-size:1px;line-height:1px">&nbsp;</td></tr>` +
    `<tr><td style="padding:24px 28px 32px">${brandHeader}` +
    `<h1 style="color:${color.ink};font-family:Georgia,serif;font-size:30px;line-height:1.18;margin:22px 0 14px">${esc(title)}</h1>` +
    `<p style="font-size:15px;line-height:1.55;margin:0 0 18px">A visitor shared the following details.</p>` +
    `<h2 style="color:${color.ink};font-size:18px;margin:0 0 8px">Contact details</h2>` +
    `<table role="presentation" style="border-collapse:collapse;border-top:1px solid ${color.border};width:100%">${fieldRows}</table>` +
    conversation +
    action +
    whatsApp +
    `<p style="border-top:1px solid ${color.border};color:${color.muted};font-size:12px;line-height:1.5;margin:28px 0 0;padding-top:14px">Sent from your Krispy form.</p>` +
    `</td></tr></table></body></html>`;

  const text = [
    title,
    "Contact details",
    ...fields.map(({ label, value }) => `${label}: ${value}`),
    ...(messages.length
      ? ["", "Conversation", ...messages.map(({ from, body }) => `${from}: ${body}`)]
      : []),
    ...(inboxUrl ? ["", `Open in Buttr: ${inboxUrl}`] : []),
    ...(whatsAppUrl ? [`Reply on WhatsApp: ${whatsAppUrl}`] : []),
  ].join("\n");
  return { subject: `New lead · ${title}`, html, text, replyTo };
}

/** Silent no-op without key/recipient; optional idempotency key preserves retry safety. */
export async function sendLeadEmail(
  apiKey: string | undefined,
  from: string | undefined,
  to: string | undefined,
  mail: LeadEmail,
  fetchImpl: FetchLike = fetch,
  idempotencyKey?: string,
): Promise<boolean> {
  if (!apiKey || !to) return false;
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: from || "leads@krispy.chat",
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      reply_to: mail.replyTo,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return response?.ok === true;
}
