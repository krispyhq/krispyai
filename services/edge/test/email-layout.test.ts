import { describe, expect, test } from "bun:test";
import { leadInboxUrl, renderLeadEmail, sendLeadEmail } from "../src/email";

const form = {
  id: "contact",
  title: "Ask about a booking",
  fields: [
    { name: "name", label: "Name", type: "text" as const },
    { name: "email", label: "Email", type: "email" as const },
  ],
};

describe("lead email rendering", () => {
  test("builds a scoped inbox link from a configured web origin", () => {
    expect(leadInboxUrl("https://app.example.com/inbox", "abc 123")).toBe(
      "https://app.example.com/inbox?sessionId=abc+123",
    );
    expect(leadInboxUrl("javascript:alert(1)", "abc")).toBeUndefined();
  });
  test("includes contact, transcript and action in HTML and plain text", () => {
    const url = "https://app.example.com/inbox?sessionId=abc123";
    const mail = renderLeadEmail(
      form,
      { name: "Dana", email: "dana@example.com" },
      [
        { role: "user", content: "Can I book for Friday?" },
        { role: "operator", content: "Yes, Friday is open." },
      ],
      undefined,
      url,
    );
    expect(mail.replyTo).toBe("dana@example.com");
    expect(mail.html).toContain("Open in Buttr");
    expect(mail.html).toContain(url.replace(/&/g, "&amp;"));
    expect(mail.text).toContain("Visitor: Can I book for Friday?");
    expect(mail.text).toContain("Your team: Yes, Friday is open.");
    expect(mail.text).toContain(`Open in Buttr: ${url}`);
  });

  test("escapes visitor text and drops unsafe action links", () => {
    const mail = renderLeadEmail(
      form,
      { name: "<script>alert('x')</script>" },
      [{ role: "user", content: "<b>hello</b>" }],
      undefined,
      "javascript:alert(1)",
    );
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>hello</b>");
    expect(mail.html).not.toContain("Open in Buttr");
    expect(mail.text).toContain("<b>hello</b>");
  });
});

test("Resend receives plain text and only an explicitly supplied idempotency key", async () => {
  const calls: RequestInit[] = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const mail = renderLeadEmail(form, { name: "Dana" }, []);
  await sendLeadEmail("test-key", "hello@example.com", "owner@example.com", mail, mockFetch);
  await sendLeadEmail(
    "test-key",
    "hello@example.com",
    "owner@example.com",
    mail,
    mockFetch,
    "lead-123",
  );
  const first = calls[0]!;
  const second = calls[1]!;
  expect((first.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  expect((second.headers as Record<string, string>)["Idempotency-Key"]).toBe("lead-123");
  expect(JSON.parse(String(second.body)).text).toBe(mail.text);
});
