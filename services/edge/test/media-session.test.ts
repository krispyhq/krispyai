import { expect, test } from "bun:test";
import { SessionDO } from "../src/session-do";
import { DO_INTERNAL_HEADER } from "../src/store";
import type { Env, SessionMedia } from "../src/types";

const visitorSecret = "v".repeat(43);
const media: SessionMedia = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "image",
  contentType: "image/png",
  name: "proof.png",
  size: 42,
};

function harness() {
  const storage = new Map<string, unknown>();
  const operatorEvents: unknown[] = [];
  const visitorEvents: unknown[] = [];
  const operator = { send: (frame: string) => operatorEvents.push(JSON.parse(frame)) };
  const visitor = { send: (frame: string) => visitorEvents.push(JSON.parse(frame)) };
  const state = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      transaction: async (run: (tx: DurableObjectStorage) => Promise<unknown>) =>
        run(state.storage),
      list: async () => new Map(),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      getAlarm: async () => null,
    },
    getWebSockets: (tag?: string) => (tag === "operator" ? [operator] : [operator, visitor]),
  } as unknown as DurableObjectState;
  const object = new SessionDO(state, { DO_INTERNAL_SECRET: "media-test" } as Env);
  const post = (path: string, body: object) =>
    object.fetch(
      new Request(`https://do${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [DO_INTERNAL_HEADER]: "media-test" },
        body: JSON.stringify(body),
      }),
    );
  return { post, storage, operatorEvents, visitorEvents };
}

test("visitor media binds the conversation, appears once, and alerts the operator", async () => {
  const h = harness();
  const base = {
    actor: "visitor",
    tenantId: "tenant-a",
    sessionId: "session-a",
    siteId: "default",
  };
  expect((await h.post("/media/authorize", { ...base, visitorSecret, create: true })).status).toBe(
    200,
  );
  expect(
    (await h.post("/media/authorize", { ...base, visitorSecret: "x".repeat(43) })).status,
  ).toBe(403);
  const first = await h.post("/media/append", {
    actor: "visitor",
    visitorSecret,
    media,
    caption: "Please look at this",
  });
  expect((await first.json()).created).toBe(true);
  const second = await h.post("/media/append", {
    actor: "visitor",
    visitorSecret,
    media,
    caption: "a duplicate retry",
  });
  expect((await second.json()).created).toBe(false);
  expect((h.storage.get("log") as unknown[]).length).toBe(1);
  expect(h.operatorEvents.some((event) => (event as { type?: string }).type === "media")).toBe(
    true,
  );
  expect(h.storage.get("handoffState")).toBe("pending");
});

test("operator media requires an existing conversation", async () => {
  const h = harness();
  const base = { actor: "operator", tenantId: "tenant-a", sessionId: "session-a" };
  expect((await h.post("/media/authorize", base)).status).toBe(409);
  await h.post("/media/authorize", {
    actor: "visitor",
    tenantId: "tenant-a",
    sessionId: "session-a",
    visitorSecret,
    create: true,
  });
  expect((await h.post("/media/authorize", base)).status).toBe(200);
  expect(
    (
      await h.post("/media/append", {
        actor: "operator",
        media: { ...media, id: "22222222-2222-4222-8222-222222222222" },
        caption: "Here is the guide",
      })
    ).status,
  ).toBe(200);
  expect(h.visitorEvents.some((event) => (event as { type?: string }).type === "media")).toBe(true);
});
