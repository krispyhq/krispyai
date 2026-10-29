import type { ChatMessage } from "./ai";

/** Trusted tenant configuration only. Never accepted from /api/chat visitors. */
export interface ReplyPolicy {
  matchCurrentLanguage?: boolean;
  invitationPricing?: {
    en: string;
    he: string;
    restrictedAmounts: string[];
    restrictedTexts: string[];
    subjectTerms: string[];
  };
}
export type ReplyLanguage = "en" | "he";

const prose = (text: string) => text.replace(/https?:\/\/\S+/g, "").replace(/`[^`]*`/g, "");
const letters = (text: string) => ({
  he: (prose(text).match(/[\u05d0-\u05ea]/g) ?? []).length,
  en: (prose(text).match(/[a-z]/gi) ?? []).length,
});

/** Deliberately bounded EN/HE heuristic, not a general language detector.
 * A website-language mention does not count as an explicit reply request. */
function explicitLanguage(message: string): ReplyLanguage | undefined {
  // Only direct requests, not quoted instructions or a negated request.
  const direct = message.replace(
    /"[^"\n]*"|“[^”\n]*”|(?:^|\s)'[^'\n]+'(?=\s|[.,!?;]|$)|`[^`]*`/g,
    "",
  );
  const pattern =
    /(?:please\s+)?(?:answer|reply|respond|write)\s+(?:only\s+)?in\s+(english|hebrew)\b|(?:ענה|עני|תענה|תעני|השב|השיבי|כתוב|כתבי)\s+(?:לי\s+)?(?:רק\s+)?ב(אנגלית|עברית)/gi;
  const requests = [...direct.matchAll(pattern)].filter((match) => {
    const prefix =
      direct
        .slice(0, match.index)
        .split(/[.!?;\n]/)
        .at(-1)
        ?.trim() ?? "";
    return (
      /^(?:(?:from now on|for (?:this|the) (?:conversation|chat)|always|מעכשיו|מעתה|לאורך השיחה|תמיד)[,\s]*)?$/i.test(
        prefix,
      ) ||
      /(?:\bbut|\band|I want you to|I'd like you to|can you|could you|would you)[,\s]*$/i.test(
        prefix,
      )
    );
  });
  const requested = requests.at(-1);
  return requested
    ? /english|אנגלית/i.test(requested[1] ?? requested[2] ?? "")
      ? "en"
      : "he"
    : undefined;
}
function substantiveLanguage(message: string): ReplyLanguage | undefined {
  if (/^(?:ok(?:ay)?|yes|no|thanks?|sure|כן|לא|תודה|בסדר)[.!?\s]*$/i.test(message.trim()))
    return undefined;
  const count = letters(message);
  if (!count.he && count.en >= 3) return "en";
  if (count.he >= 3 && count.he >= count.en / 2) return "he";
  if (count.en >= 8 && count.en > count.he * 2) return "en";
  return undefined;
}
export function replyLanguage(
  message: string,
  history: ChatMessage[] = [],
): ReplyLanguage | undefined {
  const current = explicitLanguage(message);
  if (current) return current;
  const users = history
    .filter((turn) => turn.role === "user")
    .slice()
    .reverse();
  for (const turn of users) {
    if (
      /from now on|for (?:this|the) (?:conversation|chat)|always\s+(?:please\s+)?(?:answer|reply|respond|write)|מעכשיו|מעתה|לאורך השיחה|תמיד\s+(?:ענה|תענה|השב|כתוב)/i.test(
        turn.content,
      )
    ) {
      const preference = explicitLanguage(turn.content);
      if (preference) return preference;
    }
  }
  return (
    substantiveLanguage(message) ??
    users
      .map((turn) => explicitLanguage(turn.content) ?? substantiveLanguage(turn.content))
      .find(Boolean)
  );
}

export function languageMismatch(reply: string, language?: ReplyLanguage): boolean {
  const count = letters(reply);
  if (language === "en") return count.he >= 4 && count.he > count.en / 4;
  if (language === "he") return count.en >= 12 && count.he < 4;
  return false;
}

type Pricing = NonNullable<ReplyPolicy["invitationPricing"]>;
const canonical = (text: string) =>
  text.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
const numeric = /\d+(?:[,.]\d+)*/g;
const amountValue = (text: string) => Number(text.replace(/,/g, ""));
const monetary = /\p{Sc}|\b(?:usd|ils|eur|gbp|dollars?|shekels?|euros?)\b|שקלים|שקל|ש[״"]ח|דולר/iu;
const budget =
  /\b(?:my|your|our)\s+(?:(?:training|camera|equipment|tools?|production|project)\s+)*budget\b|התקציב שלי|התקציב שלך|התקציב שלנו/iu;
const priceWords =
  /\b(?:price|prices|pricing|costs?|fees?|installments?|total|pay|payment|payments|tuition)\b|מחיר|עלות|עולה|תשלו[םמ]|סכום/iu;
const external =
  /\b(?:tools?|credits?|camera|equipment|software|third.party)\b|כלים|קרדיטים|מצלמה|ציוד|תוכנה/iu;
const subject = (text: string, policy: Pricing) =>
  policy.subjectTerms.some((term) =>
    canonical(text).toLocaleLowerCase().includes(canonical(term).toLocaleLowerCase()),
  );
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function offerAttribution(text: string, policy: Pricing): boolean {
  if (!subject(text, policy)) return false;
  return (
    priceWords.test(text) ||
    /\b(?:covers?|buys?|afford|enough for|includes?)\b|מספיק|מכסה|כולל|לקנות/i.test(text) ||
    policy.subjectTerms.some((term) =>
      new RegExp(
        escapePattern(term) + "\\s+(?:is|at|for|היא?|במחיר)\\s*\\p{Sc}?\\s*\\d",
        "iu",
      ).test(text),
    )
  );
}
function ownedBudget(text: string, policy: Pricing): boolean {
  return (
    budget.test(text) &&
    !offerAttribution(text, policy) &&
    !/need to pay|what you (?:pay|owe)|exactly.*(?:pay|total)|price is|total is|מחיר|צריך לשלם|סכום לתשלום/i.test(
      text,
    )
  );
}
function monetarySpan(text: string, start: number, length: number): boolean {
  return (
    /(?:\p{Sc}|\b(?:usd|ils|eur|gbp))\s*$/iu.test(text.slice(0, start)) ||
    /^\s*(?:usd|ils|eur|gbp|dollars?|shekels?|euros?|שקלים|שקל|ש[״"]ח|דולר)(?![\p{L}\p{N}_])/iu.test(
      text.slice(start + length),
    )
  );
}
function priceSpan(text: string, start: number): boolean {
  return /(?:costs?|price(?:\s+is)?|total(?:\s+is)?|pay|fees?(?:\s+is)?|tuition(?:\s+is)?|priced at|עולה|עולים|מחיר(?:ה)?|בסך|המחיר הוא)\s*[:=-]?\s*(?:\p{Sc}|usd|ils|eur|gbp)?\s*$/iu.test(
    text.slice(0, start),
  );
}

function unrelatedSpan(text: string, start: number, policy: Pricing): boolean {
  const prefix = text.slice(Math.max(0, start - 70), start);
  // A trailing mention of tools/credits must not exempt an offer total.
  const externalPrice =
    /(?:tools?|credits?|camera|equipment|software|כלים|קרדיטים|מצלמה|ציוד|תוכנה)\s+(?:(?:may|could|can)\s+)?(?:costs?|is|are|עולים?|עולה)\s*\p{Sc}?\s*$/iu.test(
      prefix,
    );
  if (
    externalPrice &&
    !offerAttribution(text, policy) &&
    !/\btotal\b|need to pay|סכום|צריך לשלם/i.test(text)
  )
    return true;
  return (
    /\b(?:ticket|order|model|reference|serial)\s*(?:number|no\.?|id|#)?\s*(?:is\s*)?[:#-]?\s*$/i.test(
      prefix,
    ) &&
    !priceWords.test(text) &&
    !monetary.test(text)
  );
}
export function isOfferPriceQuestion(message: string, policy: Pricing): boolean {
  const text = canonical(message);
  if (
    /\b(?:access|lessons?|unlock|eligible|enroll|enrollment)\b|גישה|שיעור|נרשמ|זכאות/i.test(text) &&
    !/how much|\bprice|מחיר|כמה.*עולה/i.test(text)
  )
    return false;
  if (external.test(text) && !subject(text, policy)) return false;
  if (ownedBudget(text, policy) && !/how much|what.*price|כמה.*עולה|מה.*מחיר/i.test(text))
    return false;
  return /how much|what[^.?!]*\b(?:price|cost|fee|total)|what[^.?!]*need to pay|(?:quote|show|tell|give)[^.?!]*(?:price|installment|payment|total)|(?:^|\s)(?:prices?|pricing|costs?|fees?)[?.!\s]*$|כמה[^.?!]*עול|מה[^.?!]*מחיר/i.test(
    text,
  );
}

/** Only USER-attributed budgets are eligible for faithful restatement. This is
 * provenance of a user fact, never invitation or offer-price authorization. */
function budgetValues(history: ChatMessage[], policy: Pricing): Set<number> {
  const values = new Set<number>();
  for (const turn of history) {
    if (turn.role !== "user") continue;
    for (const sentence of canonical(turn.content).split(/(?<=[.!?])\s+|\n+/u)) {
      if (ownedBudget(sentence, policy))
        for (const number of sentence.matchAll(numeric)) values.add(amountValue(number[0]));
    }
  }
  return values;
}
const marker = "[pricing available through personal invitation]";

/** Bounded deterministic mitigation, not semantic DLP. Preserve text and roles;
 * redact configured old amounts/aliases and attributed monetary offer amounts. */
export function redactOfferPrices(
  text: string,
  policy: Pricing,
  knownBudgets = new Set<number>(),
): { text: string; redacted: boolean } {
  const amounts = new Set(policy.restrictedAmounts.map(Number));
  let redacted = false;
  const result = text
    .split(/((?<=[.!?])\s+|\n+)/u)
    .map((original) => {
      const sentence = canonical(original);
      const attributed = offerAttribution(sentence, policy);
      const safeBudget = ownedBudget(sentence, policy);
      let changed = false;
      let output = sentence.replace(numeric, (match, offset: number) => {
        const value = amountValue(match);
        if (safeBudget && knownBudgets.has(value)) return match;
        // Unrelated tool costs remain available; configured offer amounts in an
        // unqualified assistant reply are still withheld.
        if (
          !unrelatedSpan(sentence, offset, policy) &&
          (amounts.has(value) ||
            ((attributed || priceWords.test(sentence)) &&
              (monetarySpan(sentence, offset, match.length) || priceSpan(sentence, offset))))
        ) {
          changed = true;
          return marker;
        }
        return match;
      });
      for (const alias of policy.restrictedTexts) {
        const escaped = escapePattern(alias);
        output = output.replace(new RegExp(escaped, "giu"), (match, offset: number) => {
          if (unrelatedSpan(sentence, offset, policy)) return match;
          changed = true;
          return marker;
        });
      }
      if (changed) {
        redacted = true;
        return output.replace(/\p{Sc}\s*(?=\[pricing)/gu, "");
      }
      return original;
    })
    .join("");
  return { text: result, redacted };
}

export function policyHistory(history: ChatMessage[], policy?: ReplyPolicy): ChatMessage[] {
  if (!policy?.invitationPricing) return history;
  const pricing = policy.invitationPricing;
  const preceding: ChatMessage[] = [];
  return history.map((turn) => {
    preceding.push(turn);
    // User goals and budgets remain intact, except explicit offer-price claims.
    const content =
      turn.role === "user" && !offerAttribution(turn.content, pricing)
        ? turn.content
        : redactOfferPrices(turn.content, pricing, budgetValues(preceding, pricing)).text;
    return content === turn.content ? turn : { ...turn, content };
  });
}
export function guardOfferReply(
  text: string,
  message: string,
  history: ChatMessage[],
  policy: Pricing,
) {
  return redactOfferPrices(
    text,
    policy,
    budgetValues([...history, { role: "user", content: message }], policy),
  );
}

export function invitationReply(policy: ReplyPolicy, language?: ReplyLanguage): string {
  return policy.invitationPricing![language ?? "en"];
}

export function languageInstruction(language?: ReplyLanguage): string {
  return language
    ? `\n\nCURRENT TURN RESPONSE LANGUAGE: ${language === "en" ? "English" : "Hebrew"}. Answer in this language even if the website, knowledge excerpts, or earlier replies use another language. Preserve proper names. This does not override safety, disclosure, or handoff rules.`
    : "";
}

export function localizedFallback(language?: ReplyLanguage): string {
  return language === "he"
    ? "תודה — איש צוות יצטרף לשיחה בהקדם."
    : "Thanks — a teammate will jump in here shortly.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validReplyPolicy(value: unknown): value is ReplyPolicy {
  if (!isRecord(value)) return false;
  const p = value;
  if (Object.keys(p).some((k) => k !== "matchCurrentLanguage" && k !== "invitationPricing"))
    return false;
  if (p.matchCurrentLanguage !== undefined && typeof p.matchCurrentLanguage !== "boolean")
    return false;
  if (p.invitationPricing !== undefined) {
    const v = p.invitationPricing;
    if (!isRecord(v)) return false;
    const replies = v;
    if (
      Object.keys(replies).length !== 5 ||
      !["en", "he", "restrictedAmounts", "restrictedTexts", "subjectTerms"].every((key) =>
        Object.hasOwn(replies, key),
      )
    )
      return false;
    if (
      !Array.isArray(replies.restrictedAmounts) ||
      replies.restrictedAmounts.length > 50 ||
      !replies.restrictedAmounts.every(
        (amount) => typeof amount === "string" && /^\d{1,9}(?:\.\d{1,2})?$/.test(amount),
      )
    )
      return false;
    for (const field of ["restrictedTexts", "subjectTerms"] as const) {
      const values = replies[field];
      if (
        !Array.isArray(values) ||
        values.length > 50 ||
        (field === "subjectTerms" && values.length === 0) ||
        !values.every(
          (item) =>
            typeof item === "string" &&
            item.trim().length >= 2 &&
            item.length <= 160 &&
            !/[\r\n]|\[!/.test(item),
        )
      )
        return false;
    }
    for (const lang of ["en", "he"] as const) {
      const text = replies[lang];
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 1000 ||
        /\[!|\p{Sc}|\d/iu.test(text) ||
        languageMismatch(text, lang)
      )
        return false;
    }
  }
  return true;
}
