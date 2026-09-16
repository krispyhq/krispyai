import { expect, test } from "bun:test";
import { readyEvent, RING_MAX, type RingMsg } from "../src/session-do";

test("WS ready frame carries the durable ring snapshot for reconnecting clients", () => {
  const messages: RingMsg[] = Array.from({ length: RING_MAX + 1 }, (_, i) => ({
    role: "operator",
    text: `reply-${i}`,
    ts: i,
  }));

  expect(readyEvent("operator", messages)).toEqual({
    type: "ready",
    handoffState: "operator",
    handedOff: true,
    messages: messages.slice(-RING_MAX),
  });
});
