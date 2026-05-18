/**
 * <HomeCode> — actual code, not marketing.
 *
 * HN respects code. Show the one-liner install, the CLI command, the GitHub
 * Action. Three tight blocks. Hand-rolled syntax highlighting via Tailwind
 * colour spans (no Prism / Shiki dependency — Boss Rule #2).
 *
 * Lifted directly from working examples in:
 *   - integrations/github-actions/gatetest-gate.yml
 *   - bin/gatetest.js help text
 *   - integrations/scripts/install.sh
 */

import CopyButton from "./CopyButton";

const INSTALL_CMD = "npx gatetest --suite quick";

const ACTION_YAML = `# .github/workflows/gatetest.yml
name: GateTest
on: [push, pull_request]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx gatetest --suite full --reporter sarif
        # NOTE: do NOT add continue-on-error: true here
        # The whole point of a gate is that it gates.`;

const CLI_BLOCK = `# scan a single repo locally
$ npx gatetest --suite quick

# all 102 modules, blocking gate
$ npx gatetest --suite full

# scan a public website
$ npx gatetest --url https://yoursite.com

# watch mode — re-run on every file change
$ npx gatetest --watch`;

export default function HomeCode() {
  return (
    <section id="install" className="py-24 px-6 border-t border-border bg-background-alt">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-12">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            Install
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            Zero config. <span className="gradient-text">Zero ceremony.</span>
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            One npx command for local. One YAML file for CI. The whole thing
            runs on Node 20+. No build step, no Docker image, no daemon.
          </p>
        </div>

        {/* Quickest path: npx */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-muted font-semibold">
              60 seconds &middot; from npx to gate
            </span>
            <CopyButton text={INSTALL_CMD} label="install command" variant="label" />
          </div>
          <pre className="rounded-xl border border-border bg-[#14141d] text-white p-5 overflow-x-auto text-sm font-mono leading-relaxed">
            <code>
              <span className="text-emerald-400">$</span>{" "}
              <span className="text-white">npx</span>{" "}
              <span className="text-teal-300">gatetest</span>{" "}
              <span className="text-amber-200">--suite</span>{" "}
              <span className="text-purple-300">quick</span>
            </code>
          </pre>
        </div>

        {/* CLI block */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-muted font-semibold">
              CLI cheat-sheet
            </span>
            <CopyButton text={CLI_BLOCK} label="CLI commands" variant="label" />
          </div>
          <pre className="rounded-xl border border-border bg-[#14141d] text-white p-5 overflow-x-auto text-sm font-mono leading-relaxed">
            <code>{highlightShell(CLI_BLOCK)}</code>
          </pre>
        </div>

        {/* GitHub Action */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-muted font-semibold">
              CI &middot; GitHub Actions
            </span>
            <CopyButton text={ACTION_YAML} label="GitHub Actions workflow" variant="label" />
          </div>
          <pre className="rounded-xl border border-border bg-[#14141d] text-white p-5 overflow-x-auto text-sm font-mono leading-relaxed">
            <code>{highlightYaml(ACTION_YAML)}</code>
          </pre>
        </div>

        <p className="text-xs text-muted text-center mt-6">
          Zero dependencies. Zero telemetry by default. Source is{" "}
          <a
            href="https://github.com/crclabs-hq/GateTest"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline font-medium"
          >
            on GitHub
          </a>{" "}
          — MIT-licensed. The CLI itself is free; the auto-fix tiers are paid.
        </p>
      </div>
    </section>
  );
}

/** Highlight shell-style block — comments, prompts, flags. */
function highlightShell(block: string): React.ReactNode[] {
  return block.split("\n").map((line, i) => {
    if (line.startsWith("#")) {
      return (
        <span key={i} className="text-white/35 block">
          {line}
          {"\n"}
        </span>
      );
    }
    if (line.startsWith("$")) {
      const rest = line.slice(1);
      const tokens = rest.split(/(\s+)/);
      return (
        <span key={i} className="block">
          <span className="text-emerald-400">$</span>
          {tokens.map((tok, j) => {
            if (/^\s+$/.test(tok)) return <span key={j}>{tok}</span>;
            if (tok.startsWith("--")) {
              return (
                <span key={j} className="text-amber-200">
                  {tok}
                </span>
              );
            }
            if (tok === "npx") {
              return (
                <span key={j} className="text-white">
                  {tok}
                </span>
              );
            }
            if (tok === "gatetest") {
              return (
                <span key={j} className="text-teal-300">
                  {tok}
                </span>
              );
            }
            return (
              <span key={j} className="text-white/85">
                {tok}
              </span>
            );
          })}
          {"\n"}
        </span>
      );
    }
    return (
      <span key={i} className="block">
        {line}
        {"\n"}
      </span>
    );
  });
}

/** Highlight YAML block — comments, keys, values, strings, flags. */
function highlightYaml(block: string): React.ReactNode[] {
  return block.split("\n").map((line, i) => {
    if (line.trim().startsWith("#")) {
      return (
        <span key={i} className="text-white/35 block">
          {line}
          {"\n"}
        </span>
      );
    }
    // Split on first colon to colour the key vs the value.
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && !line.trim().startsWith("-")) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      const key = line.slice(indent.length, colonIdx);
      const value = line.slice(colonIdx + 1);
      return (
        <span key={i} className="block">
          {indent}
          <span className="text-teal-300">{key}</span>
          <span className="text-white/60">:</span>
          <span className="text-amber-200">{value}</span>
          {"\n"}
        </span>
      );
    }
    if (line.trim().startsWith("-")) {
      return (
        <span key={i} className="block">
          <span className="text-white/85">{line}</span>
          {"\n"}
        </span>
      );
    }
    return (
      <span key={i} className="block">
        {line}
        {"\n"}
      </span>
    );
  });
}
