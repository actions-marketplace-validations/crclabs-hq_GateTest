import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "GateTest Installed — You're All Set",
  description: "GateTest is now scanning your repos on every push and PR.",
};

export default function Installed() {
  return (
    <div className="min-h-screen grid-bg flex items-center justify-center px-6 py-24">
      <div className="max-w-xl w-full text-center">
        {/* Success state */}
        <div className="w-20 h-20 rounded-full bg-success/10 border-2 border-success/30 flex items-center justify-center mx-auto mb-8">
          <span className="text-4xl text-success">&#10003;</span>
        </div>

        <h1 className="text-4xl font-bold mb-4">
          <span className="gradient-text">GateTest is live.</span>
        </h1>
        <p className="text-lg text-muted mb-8">
          Every push and pull request will now be automatically scanned by
          90 quality modules. Results appear as commit statuses and PR comments.
        </p>

        {/* What happens next */}
        <div className="terminal max-w-md mx-auto mb-10">
          <div className="terminal-header">
            <div className="terminal-dot bg-[#ff5f57]" />
            <div className="terminal-dot bg-[#febc2e]" />
            <div className="terminal-dot bg-[#28c840]" />
            <span className="ml-3 text-xs text-muted">What happens next</span>
          </div>
          <div className="p-6 text-left text-sm space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-success shrink-0">&#10003;</span>
              <span className="text-muted">
                Push code to any connected repo
              </span>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-success shrink-0">&#10003;</span>
              <span className="text-muted">
                GateTest scans automatically (syntax, security, a11y, perf...)
              </span>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-success shrink-0">&#10003;</span>
              <span className="text-muted">
                Green check or red X appears on your commit
              </span>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-success shrink-0">&#10003;</span>
              <span className="text-muted">
                Open a PR — detailed scan report posted as a comment
              </span>
            </div>
          </div>
        </div>

        {/* Upgrade CTA */}
        <div className="p-6 rounded-xl border border-accent/30 bg-accent/5 max-w-md mx-auto mb-8">
          <h2 className="font-bold mb-2">Want auto-fixes too?</h2>
          <p className="text-sm text-muted mb-4">
            Upgrade to Scan + Fix and GateTest will automatically create PRs
            that fix the issues it finds. From $199 per scan.
          </p>
          <Link
            href="/#pricing"
            className="inline-block px-6 py-3 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm transition-colors"
          >
            See Pricing
          </Link>
        </div>

        <Link
          href="/"
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back to gatetest.ai
        </Link>
      </div>
    </div>
  );
}
