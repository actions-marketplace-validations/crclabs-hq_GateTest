import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "How GateTest works — architecture, modules, flywheel, tiers";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#0a0a12",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          padding: "70px 90px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Top accent bar */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            background: "#2dd4bf",
          }}
        />

        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 56,
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 12,
              background: "#0f766e",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontSize: 26,
              fontWeight: 700,
            }}
          >
            G
          </div>
          <span style={{ fontSize: 36, fontWeight: 700, color: "#ffffff" }}>
            GateTest
          </span>
          <span style={{ fontSize: 18, color: "rgba(255,255,255,0.45)", marginLeft: 8 }}>
            / how it works
          </span>
        </div>

        {/* Headline */}
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            color: "#ffffff",
            lineHeight: 1.1,
            marginBottom: 28,
          }}
        >
          How GateTest works
        </div>

        {/* Subtext */}
        <div
          style={{
            fontSize: 28,
            color: "rgba(255,255,255,0.65)",
            maxWidth: 920,
            lineHeight: 1.4,
            marginBottom: 36,
          }}
        >
          102 deterministic modules. <span style={{ color: "#2dd4bf" }}>One Claude pass when it&apos;s worth it.</span> Zero hype.
        </div>

        {/* Pillars row */}
        <div
          style={{
            display: "flex",
            gap: 14,
            color: "rgba(255,255,255,0.55)",
            fontSize: 18,
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
        >
          <span style={{ padding: "6px 14px", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 999 }}>
            AST
          </span>
          <span style={{ padding: "6px 14px", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 999 }}>
            Rule
          </span>
          <span style={{ padding: "6px 14px", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 999 }}>
            Recipe
          </span>
          <span style={{ padding: "6px 14px", border: "1px solid rgba(45,212,191,0.4)", borderRadius: 999, color: "#2dd4bf" }}>
            Claude
          </span>
        </div>

        {/* Bottom bar */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            left: 90,
            right: 90,
            display: "flex",
            justifyContent: "space-between",
            color: "rgba(255,255,255,0.45)",
            fontSize: 18,
          }}
        >
          <span>gatetest.ai/how-it-works</span>
          <span>From $29 · Pay on completion</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
