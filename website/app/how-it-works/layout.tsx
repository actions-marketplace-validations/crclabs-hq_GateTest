import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How GateTest works — Architecture, modules, flywheel, tiers",
  description:
    "102 deterministic modules. One Claude pass when it's worth it. Zero hype. The full technical architecture behind GateTest — the static engine, the fix flywheel, the 4-tier deliverable, and the honest limits.",
  keywords: [
    "GateTest architecture",
    "how GateTest works",
    "static code analysis",
    "AI code review",
    "code fix flywheel",
    "deterministic scanning",
    "auto-fix pull requests",
    "Next.js serverless architecture",
    "GitHub App integration",
    "Gluecron integration",
  ],
  alternates: {
    canonical: "https://gatetest.ai/how-it-works",
  },
  openGraph: {
    title: "How GateTest works — Architecture, modules, flywheel, tiers",
    description:
      "102 deterministic modules. One Claude pass when it's worth it. The full technical architecture behind GateTest.",
    url: "https://gatetest.ai/how-it-works",
    siteName: "GateTest",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "How GateTest works",
    description:
      "The full technical architecture: static engine first, Claude last, zero hype.",
  },
};

export default function HowItWorksLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
