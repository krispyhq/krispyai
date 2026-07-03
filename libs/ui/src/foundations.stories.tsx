import type { Meta, StoryObj } from "@storybook/react-vite";

/**
 * Foundation stories — the Fresh Baked spine: color/token swatches, the type
 * scale (Fraunces / Bricolage / Geist Mono), and the Buttr expression set.
 * Swatches read live CSS vars, so the Storybook theme toolbar recolors them.
 */
const meta = {
  title: "Foundations/Overview",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

function Swatch({ name, cssVar }: { name: string; cssVar: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="h-16 w-full rounded-md border border-border"
        style={{ background: `var(${cssVar})` }}
      />
      <span className="font-mono text-[11px] font-medium text-foreground">{name}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{cssVar}</span>
    </div>
  );
}

const SEMANTIC: Array<[string, string]> = [
  ["background", "--background"],
  ["foreground", "--foreground"],
  ["card", "--card"],
  ["primary", "--primary"],
  ["secondary", "--secondary"],
  ["muted", "--muted"],
  ["accent", "--accent"],
  ["destructive", "--destructive"],
  ["border", "--border"],
  ["ring", "--ring"],
];

const ACCENTS: Array<[string, string]> = [
  ["gold", "--gold"],
  ["gold-hover", "--gold-hover"],
  ["butter", "--butter"],
  ["crust", "--crust"],
  ["acid", "--acid"],
  ["jam", "--jam"],
  ["fresh (live only)", "--fresh"],
  ["cream", "--cream"],
  ["espresso", "--espresso"],
];

export const Colors: Story = {
  render: () => (
    <div className="bg-background p-10 text-foreground">
      <h1 className="font-display text-4xl font-black tracking-tight">Fresh Baked · color</h1>
      <p className="mt-1 font-mono text-xs text-muted-foreground">
        Toggle the theme in the toolbar — swatches read live CSS vars.
      </p>

      <h2 className="mt-8 font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
        semantic roles
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-5 sm:grid-cols-4 lg:grid-cols-5">
        {SEMANTIC.map(([name, cssVar]) => (
          <Swatch key={cssVar} name={name} cssVar={cssVar} />
        ))}
      </div>

      <h2 className="mt-10 font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
        krispy accents (bold layer)
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-5 sm:grid-cols-4 lg:grid-cols-5">
        {ACCENTS.map(([name, cssVar]) => (
          <Swatch key={cssVar} name={name} cssVar={cssVar} />
        ))}
      </div>
    </div>
  ),
};

export const Typography: Story = {
  render: () => (
    <div className="bg-background p-10 text-foreground">
      <p className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
        font-display · Fraunces
      </p>
      <p className="mt-2 font-display text-[clamp(2.5rem,8vw,5rem)] font-black leading-[0.9] tracking-tight">
        the ai answers.
      </p>
      <p className="font-display text-4xl font-black tracking-tight">section title</p>

      <p className="mt-10 font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
        font-sans · Bricolage Grotesque
      </p>
      <p className="mt-2 max-w-xl text-lg">
        Body copy. Krispy answers your visitors in your voice — and taps you in on Telegram the
        second a human&apos;s needed. Warm & open, not cold & closed.
      </p>

      <p className="mt-10 font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
        font-mono · Geist Mono
      </p>
      <div className="mt-2 space-y-2 font-mono text-sm">
        <p className="uppercase tracking-[0.08em]">01 — how it works</p>
        <p>$ npx krispy init</p>
      </div>

      <p className="mt-10 font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
        scale
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        {["text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-4xl"].map(
          (c) => (
            <span key={c} className={c}>
              {c.replace("text-", "")}
            </span>
          ),
        )}
      </div>
    </div>
  ),
};

const BUTTR = ["chill", "cooking", "sparkle", "wave", "shrug", "heart", "beret", "peek"] as const;

export const ButtrExpressions: Story = {
  render: () => (
    <div className="bg-background p-10 text-foreground">
      <h1 className="font-display text-4xl font-black tracking-tight">Buttr · the mascot 🥐</h1>
      <p className="mt-1 font-mono text-xs text-muted-foreground">
        Served from /brand (libs/ui/public/brand via staticDirs).
      </p>
      <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
        {BUTTR.map((name) => (
          <div key={name} className="flex flex-col items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/brand/buttr-${name}.png`}
              alt={`Buttr ${name}`}
              className="size-28 object-contain"
            />
            <span className="font-mono text-[11px] text-muted-foreground">{name}</span>
          </div>
        ))}
      </div>
    </div>
  ),
};
