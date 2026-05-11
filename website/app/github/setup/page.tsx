import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Install GateTest — GitHub App",
  description:
    "Install GateTest on your GitHub repos. Automatic quality scanning on every push and PR.",
};

export default function GitHubSetup() {
  return (
    <div className="min-h-screen grid-bg flex items-center justify-center px-6 py-24">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-accent/30 bg-accent/5 text-sm text-accent-light mb-6">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            GitHub App
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold mb-4">
            Install <span className="gradient-text">GateTest</span> on GitHub
          </h1>
          <p className="text-lg text-muted max-w-xl mx-auto">
            One click. Every push and PR gets scanned automatically.
            90 modules. Results posted right on your pull requests.
          </p>
        </div>

        {/* Install button */}
        <div className="terminal max-w-lg mx-auto mb-10">
          <div className="terminal-header">
            <div className="terminal-dot bg-[#ff5f57]" />
            <div className="terminal-dot bg-[#febc2e]" />
            <div className="terminal-dot bg-[#28c840]" />
            <span className="ml-3 text-xs text-muted">github.com</span>
          </div>
          <div className="p-8 text-center">
            <p className="text-sm text-muted mb-6">
              GateTest will request access to read your code and post scan
              results as commit statuses and PR comments.
            </p>
            <a
              href="https://github.com/apps/GateTestHQ"
              className="inline-block px-8 py-4 text-base font-semibold rounded-xl bg-accent hover:bg-accent-light text-white transition-all pulse-glow"
            >
              Install GateTest on GitHub
            </a>
          </div>
        </div>

        {/* How it works */}
        <div className="space-y-6 max-w-lg mx-auto">
          <h2 className="text-xl font-bold text-center">How it works</h2>

          {[
            {
              step: "1",
              title: "Install the app",
              desc: "Select which repos GateTest can access. Public or private.",
            },
            {
              step: "2",
              title: "Push code or open a PR",
              desc: "GateTest automatically scans with 67 quality modules.",
            },
            {
              step: "3",
              title: "See results instantly",
              desc: "Green check or red X on your commit. Detailed report on your PR.",
            },
          ].map((item) => (
            <div
              key={item.step}
              className="flex items-start gap-4 p-4 rounded-lg border border-border bg-surface"
            >
              <div className="w-8 h-8 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
                <span className="text-sm font-bold text-accent-light">
                  {item.step}
                </span>
              </div>
              <div>
                <h3 className="font-semibold text-sm">{item.title}</h3>
                <p className="text-sm text-muted mt-1">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Permissions */}
        <div className="mt-10 max-w-lg mx-auto">
          <h3 className="text-sm font-semibold mb-3 text-center">
            Permissions requested
          </h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {[
              { perm: "Contents", level: "Read", why: "Read your code to scan it" },
              { perm: "Pull requests", level: "Write", why: "Post scan results" },
              { perm: "Commit statuses", level: "Write", why: "Show pass/fail checks" },
              { perm: "Metadata", level: "Read", why: "Know which repos to scan" },
            ].map((p) => (
              <div
                key={p.perm}
                className="p-3 rounded border border-border bg-surface/50"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{p.perm}</span>
                  <span className="text-xs text-accent-light">{p.level}</span>
                </div>
                <p className="text-xs text-muted mt-1">{p.why}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Back link */}
        <div className="text-center mt-10">
          <Link
            href="/"
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            &larr; Back to gatetest.ai
          </Link>
        </div>
      </div>
    </div>
  );
}
