import Link from "next/link";

/**
 * StackBar — cross-promotion block surfacing the three Craig-owned
 * products. Sits in the footer of every page; equal visual weight to
 * avoid looking like a promo billboard.
 *
 * Boss Rule #8 — brand copy. All taglines are pending Craig's final
 * sign-off; placeholders here are conservative drafts.
 *
 * Author: GateTest session 016MgmXrLw4Y35fnyTBLS96m, 2026-05-13.
 */

const STACK_PRODUCTS = [
  {
    name: "GateTest",
    tagline: "QA + security audit for any codebase or website.",
    href: "/",
    accent: "from-teal-500/20 to-emerald-500/10",
    badge: "G",
    badgeColor: "bg-accent",
    isHome: true,
  },
  {
    name: "Gluecron",
    tagline: "The git host built around Claude.",
    href: "https://gluecron.com",
    external: true,
    accent: "from-indigo-500/20 to-blue-500/10",
    badge: "Gc",
    badgeColor: "bg-indigo-500",
  },
  {
    name: "Crontech",
    tagline: "AI-native. Edge-first. Zero ops.",
    href: "https://crontech.ai",
    external: true,
    accent: "from-amber-500/20 to-orange-500/10",
    badge: "Ct",
    badgeColor: "bg-amber-500",
  },
];

interface Props {
  /**
   * When set, that product gets a subtle "you're here" indicator
   * instead of being a clickable link.
   */
  currentProduct?: "GateTest" | "Gluecron" | "Crontech";
}

export default function StackBar({ currentProduct = "GateTest" }: Props) {
  return (
    <section
      aria-label="Part of the Craig Canty product stack"
      className="border-t border-border/40 pt-10 pb-2"
    >
      <p className="text-xs uppercase tracking-widest text-muted text-center mb-6 font-semibold">
        Part of the same stack
      </p>
      <div className="grid sm:grid-cols-3 gap-4">
        {STACK_PRODUCTS.map((p) => {
          const isCurrent = p.name === currentProduct;
          const body = (
            <div
              className={`group h-full rounded-xl border ${
                isCurrent
                  ? "border-accent/40 bg-gradient-to-br " + p.accent
                  : "border-border bg-background-alt hover:border-accent/30 hover:bg-gradient-to-br hover:" + p.accent
              } p-5 transition-all`}
            >
              <div className="flex items-center gap-3 mb-2">
                <div
                  className={`w-7 h-7 rounded ${p.badgeColor} flex items-center justify-center flex-shrink-0`}
                >
                  <span className="text-white font-bold text-[10px] font-[var(--font-mono)]">
                    {p.badge}
                  </span>
                </div>
                <h3 className="font-bold text-sm">
                  {p.name}
                  {isCurrent && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-accent font-semibold">
                      you are here
                    </span>
                  )}
                </h3>
              </div>
              <p className="text-xs text-muted leading-relaxed">{p.tagline}</p>
              {!isCurrent && (
                <p className="text-[11px] text-accent mt-3 font-semibold group-hover:underline">
                  {p.external ? "Visit →" : "Learn more →"}
                </p>
              )}
            </div>
          );
          if (isCurrent) {
            return (
              <div key={p.name} aria-current="true">
                {body}
              </div>
            );
          }
          if (p.external) {
            return (
              <a
                key={p.name}
                href={p.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                {body}
              </a>
            );
          }
          return (
            <Link key={p.name} href={p.href} className="block">
              {body}
            </Link>
          );
        })}
      </div>
      <p className="text-[11px] text-muted text-center mt-6">
        Built by the same team. Each product is independent — use whichever solves your problem.
      </p>
    </section>
  );
}
