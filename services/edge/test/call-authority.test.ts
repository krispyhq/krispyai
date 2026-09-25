import { expect, test } from "bun:test";
import {
  coordinatorOwnsActiveCall,
  coordinatorPublicStatus,
  legacyOwnsActiveCall,
  type CallAuthority,
} from "../src/call-authority";

const marker: CallAuthority = {
  owner: "coordinator",
  callId: "11111111-1111-4111-8111-111111111111",
  version: 3,
  eventId: "visitor-invite",
  requestedBy: "visitor",
  status: "ringing",
  revision: 0,
  nonce: "opaque",
  claimExpiresAt: 60_000,
};

test("a coordinator claim blocks a concurrent legacy invite until terminal", () => {
  expect(coordinatorOwnsActiveCall(marker)).toBe(true);
  expect(coordinatorOwnsActiveCall({ ...marker, status: "ending" })).toBe(true);
  expect(coordinatorOwnsActiveCall({ ...marker, status: "ended" })).toBe(false);
});

test("a legacy call or pending room cleanup retains ownership through rollback", () => {
  const call = {
    id: marker.callId,
    room: `krispy-${marker.callId}`,
    status: "accepted" as const,
    createdAt: 1,
    expiresAt: 10,
  };
  expect(legacyOwnsActiveCall(call, null)).toBe(true);
  expect(legacyOwnsActiveCall({ ...call, status: "ended" }, call.room)).toBe(true);
  expect(legacyOwnsActiveCall({ ...call, status: "ended" }, null)).toBe(false);
});

test("coordinator status is projected into the widget's existing call vocabulary", () => {
  expect(coordinatorPublicStatus("waiting")).toBe("ringing");
  expect(coordinatorPublicStatus("ending")).toBe("ended");
  expect(coordinatorPublicStatus("accepted")).toBe("accepted");
});
