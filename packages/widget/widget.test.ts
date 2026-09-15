import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./widget.js", import.meta.url), "utf8");

function productionColorHelpers() {
  const start = source.indexOf('var BRAND_INK = "#24212e";');
  const end = source.indexOf("// Shared avatar gate", start);
  if (start < 0 || end < 0) throw new Error("widget color helpers not found");
  // Evaluate the exact trusted helper slice from widget.js so this test cannot
  // drift into a separately reimplemented contrast algorithm.
  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion
  const factory = new Function(
    `${source.slice(start, end)}; return { contrastRatio, readableForeground };`,
  ) as () => {
    contrastRatio: (first: string, second: string) => number;
    readableForeground: (background: string) => string;
  };
  return factory();
}

describe("widget visual contract", () => {
  test("the production foreground helper prefers brand ink, then strongest black or white", () => {
    const { contrastRatio, readableForeground } = productionColorHelpers();
    const cases = [
      ["#ffd447", "#24212e"],
      ["#f176a4", "#24212e"],
      ["#17131f", "#ffffff"],
      ["#777777", "#000000"],
    ] as const;

    for (const [background, expected] of cases) {
      expect(readableForeground(background)).toBe(expected);
      expect(contrastRatio(background, expected)).toBeGreaterThanOrEqual(4.5);
    }
    expect(readableForeground("not-a-color")).toBe("#24212e");
  });

  test("open and close share one transform/opacity transition with a reduced-motion exit", () => {
    expect(source).toContain("display:flex;visibility:hidden;opacity:0;pointer-events:none;");
    expect(source).toContain("transition:opacity .2s ease,transform .34s");
    expect(source).toContain("visibility:visible;opacity:1;pointer-events:auto");
    expect(source).toContain(
      "animation:none!important;transition:none!important;transform:none!important",
    );
  });

  test("existing public classes and embedder controls remain present", () => {
    for (const className of [
      "panel",
      "hd",
      "log",
      "att",
      "ft",
      "in",
      "pop",
      "btn",
      "bic",
      "brule",
      "blabel",
      "dot",
      "online",
    ]) {
      expect(source).toContain(`class="${className}`);
    }
    for (const method of ["open", "close", "toggle", "isOpen", "unread"]) {
      expect(source).toContain(`${method}:`);
    }
    expect(source).toContain('aria-hidden="true"');
    expect(source).toContain('aria-expanded="false"');
  });

  test("Buttr floats without a badge fill unless a tenant supplies one", () => {
    expect(source).toContain("--k-launcher:transparent;");
    expect(source).not.toContain("--k-launcher:var(--k-primary)");
    expect(source).toContain("var lc = clampColor(th.launcherColor);");
    expect(source).toContain('host.style.setProperty("--k-launcher", lc)');
    expect(source).toContain('panel.classList.toggle("kfill", launcherHasFill)');
    expect(source).toContain('launcher.classList.toggle("kfill", launcherHasFill)');
    expect(source).toContain("padding:7px;border-radius:0;background:transparent");
  });

  test("pill width follows the intrinsic label instead of a flex-shrunk button", () => {
    expect(source).toContain("Math.ceil(pillLabel.scrollWidth + 87)");
    expect(source).not.toContain("Math.max(116, pillBtn.scrollWidth)");
  });
});
