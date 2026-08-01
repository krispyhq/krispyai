// ALLOWED_ORIGIN grows a comma-list form: the CORS header can only carry ONE
// origin, so a list must be matched against the request's own Origin and echoed
// back — never joined. Exercised through worker.fetch on /health and OPTIONS,
// the two routes that need no bindings. Run: `bun test`.
import { expect, test, describe } from "bun:test";
import worker, { allowedOrigins, finalizeCors } from "../src/index";
import type { Env } from "../src/types";

const env = (allowed?: string) => ({ ALLOWED_ORIGIN: allowed }) as Env;

const get = (url: string, origin?: string) =>
  new Request(url, { headers: origin ? { Origin: origin } : {} });

const APP = "https://app.example.com";
const LANDING = "https://example.com";
const LIST = `${APP},${LANDING}`;

describe("allowedOrigins", () => {
  test("unset → empty; single → one; list → trimmed, no blanks, no trailing slash", () => {
    expect(allowedOrigins(env())).toEqual([]);
    expect(allowedOrigins(env(APP))).toEqual([APP]);
    expect(allowedOrigins(env(` ${APP} , ${LANDING}/ ,, `))).toEqual([APP, LANDING]);
  });
});

describe("single origin (historical behavior, unchanged)", () => {
  test("unset env stays wildcard", async () => {
    const res = await worker.fetch(get("http://edge/health"), env());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("one origin is served verbatim to everyone, no Vary added", async () => {
    const res = await worker.fetch(get("http://edge/health", "https://elsewhere.dev"), env(APP));
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("vary") ?? "").not.toContain("Origin");
  });
});

describe("origin list", () => {
  test("a listed origin is echoed back — either entry", async () => {
    for (const origin of [APP, LANDING]) {
      const res = await worker.fetch(get("http://edge/health", origin), env(LIST));
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toContain("Origin");
    }
  });

  test("an unlisted origin gets the first entry, never its own echo", async () => {
    const res = await worker.fetch(get("http://edge/health", "https://evil.dev"), env(LIST));
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
  });

  test("no Origin header (curl, same-origin) gets the first entry", async () => {
    const res = await worker.fetch(get("http://edge/health"), env(LIST));
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
  });

  test("OPTIONS preflight echoes a listed origin", async () => {
    const res = await worker.fetch(
      new Request("http://edge/api/chat", { method: "OPTIONS", headers: { Origin: LANDING } }),
      env(LIST),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(LANDING);
  });
});

describe("finalizeCors leaves what it must alone", () => {
  test("a response without the header (WS 426 path) passes through untouched", () => {
    const bare = new Response("expected websocket", { status: 426 });
    const out = finalizeCors(get("http://edge/x", LANDING), bare, env(LIST));
    expect(out).toBe(bare);
    expect(out.headers.has("access-control-allow-origin")).toBe(false);
  });
});
