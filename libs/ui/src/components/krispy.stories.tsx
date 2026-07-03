import type { Meta, StoryObj } from "@storybook/react-vite";

import { AwningStripe, ButtrSays, Receipt, Section, Stamp } from "./ui/krispy";

/**
 * The Krispy "boulangerie moderne" bold layer — mascot, awning, stamp, receipt,
 * and color-block sections. Buttr PNGs are served from /brand (see .storybook/main.ts
 * staticDirs → libs/ui/public/brand).
 */
const meta = {
  title: "Krispy/Bold Layer",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Awning: Story = {
  render: () => <AwningStripe />,
};

export const StampDefault: Story = {
  parameters: { layout: "centered" },
  render: () => <Stamp className="bg-cream" />,
};

export const StampCustom: Story = {
  parameters: { layout: "centered" },
  render: () => (
    <Stamp className="bg-cream">
      <div className="font-mono text-[11px] font-bold uppercase leading-tight tracking-[0.18em]">
        $0
        <br />
        forever
      </div>
    </Stamp>
  ),
};

export const Buttr: Story = {
  parameters: { layout: "centered" },
  render: () => (
    <div className="flex flex-col gap-6 p-8">
      <ButtrSays img="/brand/buttr-beret.png">
        bonjour — i&apos;m Buttr. a croissant runs your support now. it&apos;s going great. 🥐
      </ButtrSays>
      <ButtrSays img="/brand/buttr-shrug.png" flip>
        no shade — just facts. i&apos;m free, and i live on your box. 🥐
      </ButtrSays>
    </div>
  ),
};

export const ButtrDark: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <Section tone="espresso">
      <ButtrSays img="/brand/buttr-sparkle.png" dark>
        i handle the 3am questions so you can sleep. i don&apos;t sleep. i&apos;m bread. 🥐
      </ButtrSays>
    </Section>
  ),
};

export const InstallReceipt: Story = {
  parameters: { layout: "centered" },
  render: () => (
    <div className="w-[28rem] max-w-full p-8">
      <Receipt total="$0.00">
        <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-foreground">
          <code>
            <span className="text-fresh">$</span> git clone github.com/lonormaly/krispyai
            {"\n"}
            <span className="text-fresh">$</span> cd krispyai && bun install
            {"\n"}
            <span className="text-fresh">$</span> bun run edge:deploy{" "}
            <span className="text-muted-foreground"># live on Cloudflare, free</span>
          </code>
        </pre>
      </Receipt>
    </div>
  ),
};

/** The color-block "rooms" the landing scrolls through. */
export const SectionRooms: Story = {
  render: () => (
    <div>
      {(["cream", "surface", "muted", "espresso", "acid", "jam"] as const).map((tone) => (
        <Section key={tone} tone={tone}>
          <p className="font-mono text-xs font-bold uppercase tracking-[0.2em]">tone · {tone}</p>
          <h2 className="mt-2 font-display text-4xl font-black tracking-tight">
            a bakery art-directed a dev tool
          </h2>
        </Section>
      ))}
    </div>
  ),
};
