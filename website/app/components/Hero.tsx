"use client";

/**
 * <Hero> — world-class HN-flavoured landing hero.
 *
 * Design rules:
 *   - The hero IS the demo. URL input runs a real free scan.
 *   - Sample-URL chips pre-fill so visitors can try the product without typing.
 *   - Honest counter row — no fabricated numbers; "Launching today" badge if no
 *     real data is available.
 *   - Substance over polish: every claim ties to a real artefact (91 modules,
 *     3500+ tests, self-scan green, pay-on-completion).
 *   - Dark theme preserved. Animated grid background retained.
 *   - Mobile-first; 320px ↔ 2560px.
 *
 * The `UrlScanFlow` component is the same one used by /web — it handles the
 * full cinematic scan flow, paywall, health score, and result rendering.
 */

import { useState } from "react";
import Link from "next/link";
import { UrlScanFlow } from "./UrlScanFlow";

const SAMPLE_URLS = [
  { label: "example.com", url: "https://example.com" },
  { label: "nextjs.org", url: "https://nextjs.org" },
  { label: "vercel.com", url: "https://vercel.com" },
];

export default function Hero() {
  // Sample buttons pre-fill the input via a re-mount of UrlScanFlow with a
  // fresh `initialUrl`. Bumping the `nonce` forces React to discard the
  // previous instance and mount a new one with the seeded value already in
  // its controlled-input state — no DOM hacks, no sync events.
  const [seed, setSeed] = useState<{ url: string; nonce: number }>({ url: "", nonce: 0 });

  function prefill(url: string) {
    setSeed((s) => ({ url, nonce: s.nonce + 1 }));
    // Focus the new input on next paint so a single Enter runs the scan.
    requestAnimationFrame(() => {
      const el = document.getElementById("url-scan-input") as HTMLInputElement | null;
      if (el) el.focus();
    });
  }

  return (
    <section className="relative overflow-hidden pt-20">
      <div className="hero-dark px-6 pb-24 pt-16 relative">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hidden md:block absolute top-0 left-1/2 -translate-x-1/2 w-[760px] h-[360px] bg-gradient-to-b from-teal-500/10 to-transparent rounded-full blur-[120px] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-5xl">
          {/* Status / launch badge — honest "launching today" voice */}
          <div className="flex justify-center mb-10 fade-up">
            <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full bg-white/5 border border-white/10 text-sm text-white/70 font-medium">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
              </span>
              <span>Launching today &middot; v1.42 &middot; 91 modules live</span>
            </div>
          </div>

          {/* Headline — the claim, not a slogan */}
          <h1 className="text-center text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05] mb-6 fade-up text-white">
            One gate. <span className="hero-accent-text">91 modules.</span>
            <br />
            Self-healing CI.
          </h1>

          {/* Unfair-advantage hook */}
          <p className="text-center text-xl sm:text-2xl text-white/65 max-w-3xl mx-auto mb-3 leading-snug fade-up font-medium">
            Pay only if we fix it.
          </p>
          <p className="text-center text-base sm:text-lg text-white/45 max-w-2xl mx-auto mb-10 leading-relaxed fade-up">
            Scan your repo or any public site. We find bugs, security issues,
            and CI rot. Then we open a PR that fixes them. Card hold released
            if we can&apos;t deliver.
          </p>

          {/* Primary CTA: the live URL scan, in-hero */}
          <div className="max-w-2xl mx-auto fade-up">
            <UrlScanFlow
              key={seed.nonce}
              suite="web"
              endpoint="/api/web/scan"
              streamEndpoint="/api/web/scan/stream"
              recommendEndpoint="/api/scan/recommend"
              placeholderUrl="https://yoursite.com — free preview, no signup"
              brandLabel="GateTest"
              initialUrl={seed.url}
            />

            {/* Sample URL chips */}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs">
              <span className="text-white/40 uppercase tracking-wider font-medium">
                Try a sample
              </span>
              {SAMPLE_URLS.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  onClick={() => prefill(s.url)}
                  className="px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-white/70 hover:text-white hover:border-white/25 hover:bg-white/[0.07] transition-colors font-mono"
                >
                  {s.label}
                </button>
              ))}
              <Link
                href="/wp"
                className="px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 text-white/70 hover:text-white hover:border-white/25 hover:bg-white/[0.07] transition-colors"
              >
                WordPress site? &rarr;
              </Link>
            </div>

            {/* Honest counter row — no fabricated numbers */}
            <div className="mt-10 grid grid-cols-3 gap-3 max-w-xl mx-auto">
              <StatusCell
                label="Self-scan"
                value="GREEN"
                tone="ok"
                detail="91/91 modules"
              />
              <StatusCell
                label="Tests passing"
                value="3,500+"
                tone="ok"
                detail="every commit"
              />
              <StatusCell
                label="If we fail"
                value="$0"
                tone="ok"
                detail="card hold only"
              />
            </div>

            <p className="text-center text-xs text-white/35 mt-6">
              Want a repo scan instead?{" "}
              <a href="#pricing" className="text-teal-300 hover:text-teal-200 underline-offset-2 hover:underline">
                Pick a tier &darr;
              </a>{" "}
              or <Link href="/github/setup" className="text-teal-300 hover:text-teal-200 underline-offset-2 hover:underline">install the GitHub App</Link>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatusCell({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: "ok" | "muted";
  detail: string;
}) {
  const valueColor = tone === "ok" ? "text-emerald-300" : "text-white/80";
  return (
    <div className="rounded-xl bg-white/[0.04] border border-white/10 px-4 py-3 text-left">
      <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">
        {label}
      </div>
      <div className={`text-lg font-bold mt-1 tabular-nums ${valueColor}`}>
        {value}
      </div>
      <div className="text-[11px] text-white/40 mt-0.5">{detail}</div>
    </div>
  );
}
