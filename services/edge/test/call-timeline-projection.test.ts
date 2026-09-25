import { expect, test } from "bun:test";
import { SessionDO, RING_MAX } from "../src/session-do";
import { DO_INTERNAL_HEADER, doInternalSecret } from "../src/store";
import type { Env } from "../src/types";
import type { CallTimelineReceipt } from "../src/call-coordinator-model";

const receipt: CallTimelineReceipt = {
  callId: "11111111-1111-4111-8111-111111111111",
  sessionId: "session-one",
  startedAt: 1,
  connectedAt: 10,
  endedAt: 25,
  connectedDurationMs: 15,
  outcome: "ended",
  endTimeProvenance: "signed_event",
  revision: 5,
};

test("SessionDO stores one typed call receipt outside its bounded chat ring", async () => {
  const data = new Map<string, unknown>();
  const frames: string[] = [];
  const env = { DO_INTERNAL_SECRET: "test-internal" } as Env;
  let serial = Promise.resolve();
  const state = {
    storage: {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => void data.set(key, value),
      transaction: (run: (tx: DurableObjectStorage) => Promise<unknown>) => {
        const current = serial.then(() => run(state.storage));
        serial = current.then(
          () => undefined,
          () => undefined,
        );
        return current;
      },
      list: async ({ prefix }: { prefix?: string } = {}) =>
        new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix))),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    getWebSockets: () => [{ send: (frame: string) => void frames.push(frame) }],
  } as unknown as DurableObjectState;
  const session = new SessionDO(state, env);
  await state.storage.put("tenantId", "tenant");
  await state.storage.put("sessionId", "session-one");
  const headers = {
    [DO_INTERNAL_HEADER]: doInternalSecret(env),
    "content-type": "application/json",
  };
  const post = (path: string, body: unknown) =>
    session.fetch(
      new Request(`https://do${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  const [first, raced] = await Promise.all([
    post("/call/receipt", { tenantId: "tenant", receipt }),
    post("/call/receipt", { tenantId: "tenant", receipt }),
  ]);
  expect(first.status).toBe(200);
  expect((await first.json()).stored).toBe(true);
  expect((await raced.json()).stored).toBe(false);
  const duplicate = await post("/call/receipt", {
    tenantId: "tenant",
    receipt: { ...receipt, outcome: "missed" },
  });
  expect((await duplicate.json()).stored).toBe(false);
  expect(frames.filter((frame) => JSON.parse(frame).type === "call_receipt")).toHaveLength(1);
  expect((await post("/call/receipt", { tenantId: "other", receipt })).status).toBe(403);
  expect(
    (
      await post("/call/receipt", {
        tenantId: "tenant",
        receipt: { ...receipt, sessionId: "another-session" },
      })
    ).status,
  ).toBe(403);

  for (let i = 0; i < RING_MAX + 5; i++) {
    await post("/log", { messages: [{ role: "visitor", text: `line-${i}`, ts: 100 + i }] });
  }
  const log = await session.fetch(new Request("https://do/log", { headers }));
  const body = (await log.json()) as { messages: unknown[]; callReceipts: CallTimelineReceipt[] };
  expect(body.messages).toHaveLength(RING_MAX);
  expect(body.callReceipts).toEqual([receipt]);
});
