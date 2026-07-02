import { ImageResponse } from "next/og";
import { colors, brand } from "@krispy/ui/tokens";

// 1200×630 social card, auto-wired by Next as og:image + twitter:image. On-brand via
// the shared @krispy/ui tokens.
export const alt = "Krispy Cloud — the ai answers, you tag in";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 24,
        padding: 80,
        background: `linear-gradient(135deg, ${colors.dark.background} 0%, ${brand[950]} 100%)`,
        color: colors.dark.foreground,
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 28 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: brand[500] }} />
        <span style={{ fontWeight: 600 }}>krispy cloud</span>
      </div>
      <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.05, maxWidth: 920 }}>
        The ai answers. You tag in.
      </div>
      <div style={{ fontSize: 28, color: colors.dark.mutedForeground, maxWidth: 820 }}>
        Your Krispy Cloud dashboard — connect Telegram, teach the bot, grab your widget, manage
        billing.
      </div>
    </div>,
    { ...size },
  );
}
