import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Reference — GateTest",
  description:
    "GateTest public API v1 — scan any repo or upload files directly. Bearer auth, JSON response, idempotency support.",
};

const curlQuick = `curl -X POST https://gatetest.ai/api/v1/scan \\
  -H "Authorization: Bearer gt_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "repo_url": "https://github.com/owner/repo",
    "tier": "quick"
  }'`;

const curlDirect = `curl -X POST https://gatetest.io/api/v1/scan \\
  -H "Authorization: Bearer gt_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "files": [
      { "path": "src/index.ts", "content": "import express..." },
      { "path": "src/auth.ts", "content": "const secret = ..." }
    ],
    "tier": "full",
    "project": "zoobicon"
  }'`;

const curlFullIdem = `curl -X POST https://gatetest.io/api/v1/scan \\
  -H "Authorization: Bearer gt_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: scan-20260415-build-847" \\
  -d '{
    "repo_url": "https://github.com/owner/repo",
    "tier": "full"
  }'`;

const responseExample = `{
  "status": "complete",
  "repo_url": "https://github.com/owner/repo",
  "tier": "quick",
  "modules": [
    {
      "name": "syntax",
      "status": "passed",
      "checks": 18,
      "issues": 0,
      "duration": 42
    },
    {
      "name": "secrets",
      "status": "failed",
      "checks": 24,
      "issues": 1,
      "duration": 31,
      "details": ["src/config.js: AWS access key"]
    },
    {
      "name": "aiReview",
      "status": "skipped",
      "checks": 0,
      "issues": 0,
      "duration": 2,
      "skipped": "ANTHROPIC_API_KEY not set — AI review skipped"
    }
  ],
  "totalModules": 22,
  "completedModules": 22,
  "totalIssues": 1,
  "duration": 8421,
  "authSource": "app",
  "key": { "name": "Platform A prod", "prefix": "gt_live_abcd" }
}`;

const nodeExample = `import fetch from "node-fetch";

const res = await fetch("https://gatetest.ai/api/v1/scan", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.GATETEST_API_KEY}\`,
    "Content-Type": "application/json",
    "Idempotency-Key": \`ci-\${process.env.GITHUB_SHA}\`,
  },
  body: JSON.stringify({
    repo_url: "https://github.com/owner/repo",
    tier: "full",
  }),
});
const result = await res.json();
if (result.totalIssues > 0) process.exit(1);`;

export default function ApiDocs() {
  return (
    <div className="min-h-screen grid-bg px-6 py-24">
      <div className="max-w-4xl mx-auto">
        <div className="mb-10">
          <p className="text-xs font-mono uppercase tracking-wider text-accent mb-2">
            API Reference · v1
          </p>
          <h1 className="text-4xl font-bold mb-3">GateTest Public API</h1>
          <p className="text-muted leading-relaxed">
            Scan any GitHub repo programmatically. Every module advertised runs real
            analysis or returns an honest <code className="font-mono text-sm">skipped</code>{" "}
            reason — we never fake-pass.
          </p>
        </div>

        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-3">Authentication</h2>
          <p className="text-muted mb-4">
            Every request requires a GateTest API key. Pass it via{" "}
            <code className="font-mono text-sm">Authorization: Bearer &lt;key&gt;</code>{" "}
            or the <code className="font-mono text-sm">X-API-Key</code> header. Keys start
            with <code className="font-mono text-sm">gt_live_</code> and are issued from
            the admin console. Only the hash is stored — keep the plaintext safe.
          </p>
          <div className="card p-4 text-xs text-muted">
            Request a key: email <a className="text-accent hover:underline" href="mailto:hello@gatetest.ai">hello@gatetest.ai</a>
            {" "}with your platform name and expected scan volume.
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-3">POST /api/v1/scan</h2>
          <p className="text-muted mb-4">
            Two input modes: provide a <code className="font-mono text-sm">repo_url</code>{" "}
            (GitHub) or upload <code className="font-mono text-sm">files[]</code> directly
            (any platform — no GitHub required). Same 90 modules, same response format.
            Typical latency: 5–15 s for <code className="font-mono text-sm">quick</code>,
            20–60 s for <code className="font-mono text-sm">full</code>.
          </p>

          <h3 className="text-lg font-semibold mb-2">Request body</h3>
          <div className="card overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-solid">
                  <th className="text-left px-4 py-2 font-medium">Field</th>
                  <th className="text-left px-4 py-2 font-medium">Type</th>
                  <th className="text-left px-4 py-2 font-medium">Required</th>
                  <th className="text-left px-4 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs">repo_url</td>
                  <td className="px-4 py-2 text-xs">string</td>
                  <td className="px-4 py-2 text-xs">mode A</td>
                  <td className="px-4 py-2 text-xs text-muted">github.com URL — GateTest reads the repo via API</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs">files</td>
                  <td className="px-4 py-2 text-xs">{`{path, content}[]`}</td>
                  <td className="px-4 py-2 text-xs">mode B</td>
                  <td className="px-4 py-2 text-xs text-muted">Direct upload — send file contents inline (max 100 files, 500 KB each)</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs">project</td>
                  <td className="px-4 py-2 text-xs">string</td>
                  <td className="px-4 py-2 text-xs">no</td>
                  <td className="px-4 py-2 text-xs text-muted">Label for direct uploads (e.g. &quot;zoobicon&quot;)</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-xs">tier</td>
                  <td className="px-4 py-2 text-xs">string</td>
                  <td className="px-4 py-2 text-xs">no</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    <code className="font-mono">quick</code> (default, 4 modules) or{" "}
                    <code className="font-mono">full</code> (90 modules). Key must be
                    entitled.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="text-lg font-semibold mb-2">Mode A — GitHub repo</h3>
          <pre className="card p-4 text-xs font-mono overflow-x-auto mb-6">{curlQuick}</pre>

          <h3 className="text-lg font-semibold mb-2">Mode B — Direct file upload</h3>
          <p className="text-muted text-sm mb-3">
            No GitHub required. Send file paths and contents inline — works for any
            platform, any language, any framework.
          </p>
          <pre className="card p-4 text-xs font-mono overflow-x-auto mb-6">{curlDirect}</pre>

          <h3 className="text-lg font-semibold mb-2">Full scan with idempotency</h3>
          <p className="text-muted text-sm mb-3">
            Pass an <code className="font-mono">Idempotency-Key</code> header to deduplicate
            retries within 24 hours. Useful from CI where a build may retry.
          </p>
          <pre className="card p-4 text-xs font-mono overflow-x-auto mb-6">{curlFullIdem}</pre>

          <h3 className="text-lg font-semibold mb-2">Example response</h3>
          <pre className="card p-4 text-xs font-mono overflow-x-auto">{responseExample}</pre>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-3">Module statuses</h2>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-solid">
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Meaning</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs text-success">passed</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    Module ran, performed at least 1 check, found 0 issues.
                  </td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs text-danger">failed</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    Module found ≥ 1 issue (see <code>details</code>) or threw during
                    execution.
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-xs text-muted">skipped</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    Module could not run honestly (e.g. missing config, nothing to
                    inspect). <code>skipped</code> field explains why. Never treated as a
                    pass.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-3">Errors</h2>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-solid">
                  <th className="text-left px-4 py-2 font-medium">HTTP</th>
                  <th className="text-left px-4 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs">400</td>
                  <td className="px-4 py-2 text-xs text-muted">Missing or malformed body / repo_url / tier.</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs">401</td>
                  <td className="px-4 py-2 text-xs text-muted">Missing or invalid API key.</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs">403</td>
                  <td className="px-4 py-2 text-xs text-muted">Key revoked, or tier not entitled on this key.</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs">429</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    Rate limit exceeded. Response body includes{" "}
                    <code className="font-mono">rate_limit_per_hour</code>. Respect{" "}
                    <code className="font-mono">Retry-After</code>.
                  </td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-2 font-mono text-xs">500</td>
                  <td className="px-4 py-2 text-xs text-muted">Scan crashed — retry with the same idempotency key is safe.</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-xs">502</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    Could not access the GitHub repo. Usually means private repo without
                    a GateTest GitHub App install.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-3">Node.js example (CI gate)</h2>
          <pre className="card p-4 text-xs font-mono overflow-x-auto">{nodeExample}</pre>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-3">Private repos</h2>
          <p className="text-muted leading-relaxed">
            Install the{" "}
            <a
              href="https://github.com/apps/gatetesthq"
              className="text-accent hover:underline"
            >
              GateTest GitHub App
            </a>{" "}
            on your repo or organisation. GateTest will mint a short-lived installation
            token at scan time — your API key stays untouched by GitHub.
          </p>
        </section>

        <div className="text-xs text-muted border-t border-border pt-6">
          Support: <a className="text-accent hover:underline" href="mailto:hello@gatetest.ai">hello@gatetest.ai</a> ·{" "}
          <a className="text-accent hover:underline" href="/legal/terms">Terms</a> ·{" "}
          <a className="text-accent hover:underline" href="/legal/privacy">Privacy</a>
        </div>
      </div>
    </div>
  );
}
