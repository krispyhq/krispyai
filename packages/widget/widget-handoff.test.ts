import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./widget.js", import.meta.url), "utf8");
const start = source.indexOf("  function removeHandoffChoices() {");
const end = source.indexOf("  // ── CTA engine", start);
if (start < 0 || end < 0) throw new Error("handoff choice controller not found");

type FakeNode = {
  className: string;
  textContent: string;
  children: FakeNode[];
  readonly lastElementChild?: FakeNode;
  isConnected: boolean;
  href?: string;
  click: () => void;
  appendChild: (child: FakeNode) => void;
  remove: () => void;
  addEventListener: (name: string, handler: () => void) => void;
  scrollIntoView: () => void;
};
function node(): FakeNode {
  return {
    className: "",
    textContent: "",
    children: [],
    get lastElementChild() {
      return this.children.at(-1);
    },
    isConnected: true,
    click() {},
    appendChild(child) {
      this.children = this.children.filter((existing) => existing !== child);
      this.children.push(child);
      child.isConnected = true;
    },
    remove() {
      this.isConnected = false;
    },
    addEventListener(name, handler) {
      if (name === "click") this.click = handler;
    },
    scrollIntoView() {},
  };
}
function harness() {
  const log = node();
  const hiddenCallCards: string[] = [];
  const callEl = {
    classList: {
      remove(name: string) {
        hiddenCallCards.push(name);
      },
    },
  };
  const shownForms: string[] = [];
  const requested: string[] = [];
  const document = { visibilityState: "visible", createElement: () => node() };
  const forms = [{ id: "details", title: "Leave details", fields: [{ name: "email" }] }];
  const ctas = [{ type: "instagram", label: "DM us", url: "https://instagram.com/example" }];
  // Execute the production controller with the existing renderers stubbed at its boundaries.
  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion
  const factory = new Function(
    "document",
    "log",
    "callEl",
    "forms",
    "ctas",
    "shownForms",
    "requested",
    `
    var handoffState = "pending", handoffChoiceDismissed = false, handoffChoices = null;
    var formOpen = false, callCanRequest = false, visitorSecret = "secret", callVisitorConnected = true, callState = null;
    function showForm(form) { shownForms.push(form.id); formOpen = true; }
    function renderCta(cta, container) { var a = document.createElement("a"); a.textContent = cta.label; a.href = cta.url; container.appendChild(a); return a; }
    function renderCall() {}
    function callRequest(action) { requested.push(action); return Promise.resolve({ call: { status: "ringing" } }); }
    function showCallError() {}
    ${source.slice(start, end)}
    return {
      refresh: refreshHandoffChoices, remove: removeHandoffChoices,
      card: () => handoffChoices,
      setState: (state) => { handoffState = state; },
      setCallAvailable: (available) => { callCanRequest = available; },
      setCallState: (state) => { callState = state; },
    };
  `,
  ) as (...args: unknown[]) => {
    refresh: () => void;
    remove: () => void;
    card: () => FakeNode | null;
    setState: (state: string) => void;
    setCallAvailable: (available: boolean) => void;
    setCallState: (state: object | null) => void;
  };
  return {
    ...factory(document, log, callEl, forms, ctas, shownForms, requested),
    forms,
    ctas,
    shownForms,
    requested,
    hiddenCallCards,
  };
}
function buttons(card: FakeNode | null) {
  return card?.children[1]?.children ?? [];
}

describe("pending handoff choices", () => {
  test("empty tenant configuration creates no contact form or links", () => {
    const app = harness();
    app.forms.length = 0;
    app.ctas.length = 0;
    app.refresh();
    expect(app.card()).toBeNull();
    expect(app.shownForms).toEqual([]);
  });

  test("only configured routes render, and a form choice opens the existing form", () => {
    const app = harness();
    app.refresh();
    expect(buttons(app.card()).map((item) => item.textContent)).toEqual(["Leave details", "DM us"]);
    expect(buttons(app.card())[1]?.href).toBe("https://instagram.com/example");
    buttons(app.card())[0]?.click();
    expect(app.shownForms).toEqual(["details"]);
    expect(app.card()).toBeNull();
    app.refresh();
    expect(app.card()).toBeNull();
  });

  test("a changed form with the same ID refreshes its choice while unchanged config keeps the card", () => {
    const app = harness();
    app.refresh();
    const first = app.card();
    app.refresh();
    expect(app.card()).toBe(first);
    app.forms[0]!.fields.push({ name: "phone" });
    app.refresh();
    expect(app.card()).not.toBe(first);
    expect(app.card()?.isConnected).toBe(true);
  });

  test("call appears only when status permits and pending choices disappear on takeover", () => {
    const app = harness();
    app.setCallAvailable(true);
    app.refresh();
    expect(buttons(app.card()).map((item) => item.textContent)).toContain("Request a call");
    expect(app.hiddenCallCards).toContain("on");
    const original = app.card();
    app.refresh();
    expect(app.card()).toBe(original);
    app.setCallState({ status: "ringing" });
    app.refresh();
    expect(buttons(app.card()).map((item) => item.textContent)).not.toContain("Request a call");
    app.setCallState({ status: "expired" });
    app.refresh();
    expect(buttons(app.card()).map((item) => item.textContent)).toContain("Request a call");
    app.setState("operator");
    app.refresh();
    expect(app.card()).toBeNull();
    app.setState("ai");
    app.refresh();
    expect(app.card()).toBeNull();
  });
});
