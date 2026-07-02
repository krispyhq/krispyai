/**
 * Krispy "boulangerie moderne" bold-layer components.
 *
 * These are Krispy-bespoke (not shadcn primitives): the mascot aside, the awning
 * stripe, the wax stamp, the receipt card, and the color-block Section helper.
 * They codify patterns the landing (apps/landing/app/page.tsx) hand-rolls so the
 * app can migrate to `@krispy/ui`. All tokens come from globals.css CSS vars.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

/* ─────────────────────────────────────────────────────────────────────────
 * AwningStripe — French-bakery awning: bold jam/cream diagonal stripes.
 * Pure CSS (always renders, crisper than a PNG). Decorative → hidden from a11y.
 * ──────────────────────────────────────────────────────────────────────── */
function AwningStripe({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      data-slot="awning-stripe"
      className={cn("h-3.5 w-full", className)}
      style={{
        backgroundImage:
          "repeating-linear-gradient(-45deg, var(--jam) 0 22px, var(--cream) 22px 44px)",
        ...props.style,
      }}
      {...props}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Stamp — rotated mono wax-stamp badge with a jam ring. Defaults to "FAIT
 * MAISON"; pass children to override the stamped text.
 * ──────────────────────────────────────────────────────────────────────── */
function Stamp({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stamp"
      className={cn(
        "grid size-28 -rotate-12 place-items-center rounded-full border-2 border-jam text-center text-jam",
        className,
      )}
      style={{ boxShadow: "inset 0 0 0 2px var(--jam)", ...props.style }}
      {...props}
    >
      {children ?? (
        <div className="font-mono text-[10px] font-bold uppercase leading-tight tracking-[0.18em]">
          fait
          <br />
          maison
          <br />
          <span className="text-[8px] tracking-[0.12em] opacity-70">· fresh daily ·</span>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * ButtrSays — the mascot narrating. A speech bubble in Buttr's voice; `dark`
 * flips the bubble for espresso rooms, `flip` mirrors mascot ↔ bubble.
 * ──────────────────────────────────────────────────────────────────────── */
function ButtrSays({
  img,
  alt = "Buttr the croissant mascot",
  children,
  dark = false,
  flip = false,
  className,
}: {
  /** Buttr expression PNG, e.g. "/brand/buttr-sparkle.png". */
  img: string;
  alt?: string;
  children: React.ReactNode;
  /** Use on dark/espresso surfaces — bubble becomes cream. */
  dark?: boolean;
  /** Mirror layout: bubble on the left, mascot on the right. */
  flip?: boolean;
  className?: string;
}) {
  return (
    <div
      data-slot="buttr-says"
      className={cn("flex items-center gap-3", flip && "flex-row-reverse", className)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- framework-agnostic lib, no next/image */}
      <img src={img} alt={alt} className="size-20 shrink-0 object-contain" />
      <p
        className={cn(
          "max-w-xs rounded-2xl border-2 border-espresso px-4 py-2.5 font-mono text-sm font-medium shadow-[4px_4px_0_0_var(--espresso)]",
          dark ? "bg-cream text-espresso" : "bg-card text-foreground",
        )}
      >
        {children}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Receipt — the install-snippet / order-slip card: awning header, mono body,
 * dashed header + total rows. Code-as-hero, "fait maison" register.
 * ──────────────────────────────────────────────────────────────────────── */
function Receipt({
  label = "self-host · fait maison",
  no = "001",
  total,
  totalLabel = "merci · total",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /** Mono uppercase header label. */
  label?: React.ReactNode;
  /** Slip number, shown top-right. */
  no?: React.ReactNode;
  /** Total value, shown in the dashed footer (omit to hide the footer). */
  total?: React.ReactNode;
  totalLabel?: React.ReactNode;
}) {
  return (
    <div
      data-slot="receipt"
      className={cn(
        "overflow-hidden rounded-[14px] border-2 border-espresso bg-card shadow-[6px_6px_0_0_var(--espresso)]",
        className,
      )}
      {...props}
    >
      <AwningStripe />
      <div className="p-8">
        <div className="mb-5 flex items-center justify-between border-b border-dashed border-espresso/30 pb-4">
          <p className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
            {label}
          </p>
          <span className="font-mono text-xs text-muted-foreground">no. {no}</span>
        </div>
        {children}
        {total != null && (
          <div className="mt-5 flex items-center justify-between border-t border-dashed border-espresso/30 pt-4 font-mono text-xs">
            <span className="uppercase tracking-[0.2em] text-crust">{totalLabel}</span>
            <span className="text-lg font-black text-jam">{total}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Section — color-block "room" helper. The landing alternates cream / espresso /
 * acid / jam / muted bands; this centralizes tone + the standard inner container.
 * ──────────────────────────────────────────────────────────────────────── */
const sectionVariants = cva("w-full", {
  variants: {
    tone: {
      cream: "bg-cream text-foreground",
      surface: "bg-card text-card-foreground",
      muted: "bg-muted text-foreground border-t-2 border-espresso",
      espresso: "bg-espresso text-cream",
      acid: "bg-acid text-espresso border-y-2 border-espresso",
      jam: "bg-jam text-cream border-y-2 border-espresso",
    },
  },
  defaultVariants: { tone: "cream" },
});

function Section({
  tone,
  className,
  innerClassName,
  bare = false,
  children,
  ...props
}: React.ComponentProps<"section"> &
  VariantProps<typeof sectionVariants> & {
    /** Extra classes on the inner max-w container. */
    innerClassName?: string;
    /** Skip the inner container + padding; render children directly in the band. */
    bare?: boolean;
  }) {
  return (
    <section data-slot="section" className={cn(sectionVariants({ tone }), className)} {...props}>
      {bare ? (
        children
      ) : (
        <div className={cn("mx-auto max-w-6xl px-6 py-16 md:py-20", innerClassName)}>
          {children}
        </div>
      )}
    </section>
  );
}

export { AwningStripe, Stamp, ButtrSays, Receipt, Section, sectionVariants };
