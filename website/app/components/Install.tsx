import Link from "next/link";

export default function Install() {
  return (
    <section id="install" className="py-24 px-6 border-t border-border/30 grid-bg relative">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-accent/5 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="text-center mb-14">
          <span className="text-sm font-semibold text-accent-light uppercase tracking-wider">
            Install GateTest
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4">
            Two ways to get the gate <span className="gradient-text">on your repo</span>.
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            Pick the install path that fits your stack. Both run the same 90 modules
            against every push.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Path 1: GitHub App — zero config */}
          <div className="rounded-xl p-7 border border-accent/30 bg-accent/5 flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center font-[var(--font-mono)] font-bold text-accent-light">
                1
              </div>
              <div>
                <h3 className="font-semibold text-lg">GitHub App &mdash; one click</h3>
                <p className="text-xs text-muted">Recommended. No CI config to write.</p>
              </div>
            </div>
            <p className="text-sm text-muted mb-5">
              Install GateTest on the repos you choose. Every push and pull request
              gets scanned automatically &mdash; results land as a commit status and a
              PR comment with the full breakdown.
            </p>
            <ul className="text-sm space-y-2 mb-6">
              <li className="flex items-start gap-2">
                <span className="text-accent-light mt-0.5">&#10003;</span>
                <span className="text-foreground">Public or private repos &mdash; you choose which</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent-light mt-0.5">&#10003;</span>
                <span className="text-foreground">Read access only &mdash; we never push to your branch</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent-light mt-0.5">&#10003;</span>
                <span className="text-foreground">Block merges on failure with branch protection</span>
              </li>
            </ul>
            <div className="mt-auto flex flex-col sm:flex-row gap-3">
              <a
                href="https://github.com/apps/GateTestHQ"
                className="btn-cta px-6 py-3 text-sm font-semibold rounded-xl text-center"
              >
                Install GitHub App &rarr;
              </a>
              <Link
                href="/github/setup"
                className="px-6 py-3 text-sm font-semibold rounded-xl border border-border text-foreground hover:border-accent/50 transition-colors text-center"
              >
                See setup guide
              </Link>
            </div>
          </div>

          {/* Path 2: CLI — self-hosted CI */}
          <div className="rounded-xl p-7 border border-border bg-surface flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-surface-light border border-border flex items-center justify-center font-[var(--font-mono)] font-bold text-foreground">
                2
              </div>
              <div>
                <h3 className="font-semibold text-lg">CLI in your CI &mdash; one line</h3>
                <p className="text-xs text-muted">For GitLab, Jenkins, CircleCI, anything self-hosted.</p>
              </div>
            </div>
            <p className="text-sm text-muted mb-5">
              Drop the gate into any pipeline. Installs from npm, runs against the
              checked-out workspace, exits non-zero on any error-severity issue so
              your existing branch protection blocks the merge.
            </p>

            <div className="rounded-lg bg-[#0a0a12] border border-white/10 p-4 mb-5 font-[var(--font-mono)] text-xs overflow-x-auto">
              <p className="text-white/40 mb-1"># install</p>
              <p className="text-emerald-400 mb-3">npx gatetest --suite full</p>
              <p className="text-white/40 mb-1"># or pin to your CI runner</p>
              <p className="text-emerald-400">npm i -D gatetest && npx gatetest --suite full --reporter sarif</p>
            </div>

            <ul className="text-sm space-y-2 mb-6">
              <li className="flex items-start gap-2">
                <span className="text-accent-light mt-0.5">&#10003;</span>
                <span className="text-foreground">Zero runtime dependencies &mdash; pure Node 20+</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent-light mt-0.5">&#10003;</span>
                <span className="text-foreground">5 reporters: console, JSON, HTML, SARIF, JUnit</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent-light mt-0.5">&#10003;</span>
                <span className="text-foreground">Diff-mode for PRs &mdash; only scan what changed</span>
              </li>
            </ul>
            <div className="mt-auto">
              <Link
                href="/docs/api"
                className="text-sm font-semibold text-accent-light hover:underline"
              >
                Full CLI reference &rarr;
              </Link>
            </div>
          </div>
        </div>

        {/* Bottom strip — scan-on-demand path */}
        <div className="mt-6 rounded-xl border border-border bg-surface/50 p-6 text-center">
          <p className="text-sm text-muted">
            Just want a one-off scan?{" "}
            <a href="#pricing" className="text-accent-light font-semibold hover:underline">
              Pay-on-completion pricing &rarr;
            </a>
            {" "}&mdash; nothing to install, results in under 60 seconds.
          </p>
        </div>
      </div>
    </section>
  );
}
