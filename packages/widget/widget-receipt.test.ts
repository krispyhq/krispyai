import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./widget.js", import.meta.url), "utf8");
const start = source.indexOf("  // Call receipts are durable server records,");
const end = source.indexOf("  // A reconnect's ready frame", start);
if (start < 0 || end < 0) throw new Error("widget call receipt renderer not found");

class FakeNode {
  children: FakeNode[] = [];
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  dateTime = "";
  isConnected = false;
  scrollTop = 0;
  scrollHeight = 0;
  appendChild(child: FakeNode) {
    this.children = this.children.filter((item) => item !== child);
    child.isConnected = true;
    this.children.push(child);
  }
  insertBefore(child: FakeNode, next: FakeNode) {
    this.children = this.children.filter((item) => item !== child);
    this.children.splice(this.children.indexOf(next), 0, child);
    child.isConnected = true;
  }
  replaceChildren() {
    this.children = [];
  }
}

function harness() {
  const log = new FakeNode();
  const document = { createElement: () => new FakeNode() };
  // Run the production renderer with the server's typed WS envelope.
  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion
  const factory = new Function(
    "document",
    "log",
    "sessionId",
    `${source.slice(start, end)}; return renderCallReceipt;`,
  ) as (document: object, log: FakeNode, sessionId: string) => (event: unknown) => void;
  return { log, render: factory(document, log, "visitor-session") };
}

const receipt = {
  callId: "call-1",
  sessionId: "visitor-session",
  startedAt: Date.UTC(2026, 8, 25, 16, 0),
  connectedAt: Date.UTC(2026, 8, 25, 16, 0, 4),
  connectedTimeProvenance: "signed_event",
  endedAt: Date.UTC(2026, 8, 25, 16, 0, 38),
  connectedDurationMs: 34_000,
  outcome: "ended",
  endTimeProvenance: "signed_event",
  revision: 1,
};

test("typed call receipts show server time and verified duration once per call/revision", () => {
  const app = harness();
  const older = new FakeNode();
  older.dataset.krispyAt = String(receipt.endedAt - 1_000);
  const newer = new FakeNode();
  newer.dataset.krispyAt = String(receipt.endedAt + 1_000);
  app.log.appendChild(older);
  app.log.appendChild(newer);
  app.log.scrollTop = 17;
  app.render({ type: "call_receipt", receipt });
  expect(app.log.children).toHaveLength(3);
  const card = app.log.children[1]!;
  expect(app.log.children).toEqual([older, card, newer]);
  expect(app.log.scrollTop).toBe(17);
  expect(card.className).toBe("callreceipt");
  expect(card.children.map((part) => part.textContent)).toEqual([
    "Audio call ended",
    expect.any(String),
    "Connected 0:34",
  ]);
  expect(card.children[1]!.dateTime).toBe(new Date(receipt.endedAt).toISOString());
  app.render({ type: "call_receipt", receipt }); // reconnect replay
  expect(app.log.children).toEqual([older, card, newer]);
  app.render({
    type: "call_receipt",
    receipt: { ...receipt, revision: 2, connectedDurationMs: 35_000 },
  });
  expect(app.log.children).toEqual([older, card, newer]);
  expect(card.children[2]!.textContent).toBe("Connected 0:35");
  app.render({
    type: "call_receipt",
    receipt: {
      ...receipt,
      revision: 3,
      endTimeProvenance: "observed_room_absent",
    },
  });
  expect(card.children[1]!.textContent).toStartWith("Around ");
  expect(card.children[2]!.textContent).toBe("Approx. connected 0:34");
  app.render({
    type: "call_receipt",
    receipt: {
      ...receipt,
      revision: 4,
      connectedTimeProvenance: "observed_room_present",
    },
  });
  expect(card.children[1]!.textContent).toStartWith("Around ");
  expect(card.children[2]!.textContent).toBe("Approx. connected 0:34");
  app.render({
    type: "call_receipt",
    receipt: {
      ...receipt,
      revision: 5,
      endTimeProvenance: "confirmed_room_delete",
    },
  });
  expect(card.children[2]!.textContent).toBe("Approx. connected 0:34");
  app.render({ type: "call_receipt", receipt: { ...receipt, revision: 1 } });
  expect(card.children[2]!.textContent).toBe("Approx. connected 0:34");
});

test("receipt renderer keeps sessions separate and labels unanswered outcomes", () => {
  const app = harness();
  app.render({ type: "call_receipt", receipt: { ...receipt, sessionId: "other" } });
  app.render({ type: "call_receipt", receipt: { ...receipt, endedAt: Infinity } });
  app.render({ type: "call_receipt", receipt: { ...receipt, connectedTimeProvenance: null } });
  expect(app.log.children).toHaveLength(0);
  app.render({
    type: "call_receipt",
    receipt: {
      ...receipt,
      callId: "call-2",
      connectedAt: null,
      connectedTimeProvenance: null,
      connectedDurationMs: 0,
      outcome: "missed",
      transcript: "must not appear",
    },
  });
  expect(app.log.children).toHaveLength(1);
  expect(app.log.children[0]!.children.map((part) => part.textContent)).toEqual([
    "Missed audio call",
    expect.any(String),
    "Not connected",
  ]);
  expect(JSON.stringify(app.log.children)).not.toContain("must not appear");
});
