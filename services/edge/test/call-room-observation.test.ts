import { expect, test } from "bun:test";
import { observeCallRoom } from "../src/call-token";

const id = "11111111-1111-4111-8111-111111111111";
const config = { url: "wss://rtc.example.test", apiKey: "test-key", apiSecret: "test-secret" };

test("authenticated LiveKit query requires both expected identities ACTIVE", async () => {
  const requests: { url: string; token: string; room: string }[] = [];
  const query = (participants: { identity: string; state: number | string }[]) =>
    observeCallRoom(config, id, async (input, init) => {
      requests.push({
        url: String(input),
        token: String((init?.headers as Record<string, string> | undefined)?.authorization),
        room: (JSON.parse(String(init?.body)) as { room: string }).room,
      });
      return Response.json({ participants });
    });
  expect(
    await query([
      { identity: `operator-${id}`, state: 2 },
      { identity: `visitor-${id}`, state: "ACTIVE" },
    ]),
  ).toBe("both_active");
  expect(
    await query([
      { identity: `operator-${id}`, state: 1 },
      { identity: `visitor-${id}`, state: 2 },
    ]),
  ).toBe("not_both");
  expect(requests[0]).toMatchObject({
    url: "https://rtc.example.test/twirp/livekit.RoomService/ListParticipants",
    room: `krispy-${id}`,
  });
  expect(requests[0]!.token.startsWith("Bearer ")).toBe(true);
});

test("only a typed LiveKit not_found confirms room absence; network errors stay unknown", async () => {
  expect(
    await observeCallRoom(config, id, async () =>
      Response.json({ code: "not_found" }, { status: 404 }),
    ),
  ).toBe("room_absent");
  expect(
    await observeCallRoom(config, id, async () =>
      Response.json({ code: "permission_denied" }, { status: 404 }),
    ),
  ).toBe("unknown");
  expect(
    await observeCallRoom(config, id, async () => {
      throw new Error("offline");
    }),
  ).toBe("unknown");
});
