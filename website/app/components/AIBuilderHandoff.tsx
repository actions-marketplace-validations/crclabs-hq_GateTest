"use client";

/**
 * AIBuilderHandoff — the "send these findings somewhere intelligent"
 * surface that lives next to the live fix progress on /scan/status and
 * /admin. Six export formats (Claude Code, Cursor, Cline+Aider, GitHub
 * Issue, JSON, Markdown), severity / module / search filters, copy +
 * download + share buttons, and an honest banner when our own fix loop
 * couldn't ship a PR.
 *
 * Goal: give every customer a useful next step REGARDLESS of whether
 * GateTest's auto-fix succeeds. Anthropic outage? Export to Cursor and
 * keep moving. On a tier without auto-fix? Export to Claude Code.
 * Want to triage in Linear first? Export as GitHub Issue. Etc.
 *
 * Pure-presentation component. All formatting logic is in
 * `app/lib/ai-handoff.js` and unit-tested separately.
 */

import { useMemo, useState, useEffect } from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const handoff = require("@/app/lib/ai-handoff.js") as {
  SUPPORTED_FORMATS: string[];
  FORMAT_LABELS: Record<string, string>;
  buildFindings: (modules: ModuleResult[]) => Finding[];
  groupByFile: (findings: Finding[]) => Array<[string, Finding[]]>;
  counts: (findings: Finding[]) => { total: number; error: number; warning: number; info: number };
  filterFindings: (findings: Finding[], opts: FilterOpts) => Finding[];
  formatHandoff: (
    fmt: string,
    findings: Finding[],
    opts: { repoUrl?: string; tier?: string }
  ) => { content: string; filename: string; mimeType: string };
};

interface ModuleResult {
  name: string;
  status: string;
  details?: string[];
}

interface Finding {
  id: string;
  module: string;
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
  raw: string;
}

interface FilterOpts {
  severity?: "all" | "error" | "warning" | "info";
  module?: string;
  query?: string;
}

interface Props {
  modules: ModuleResult[];
  repoUrl?: string;
  tier?: string;
  fixFailed?: boolean;
  fixFailureReason?: string;
}

const FORMAT_DESCRIPTIONS: Record<string, string> = {
  "claude-code": "Paste into Claude Code or claude.ai — best for full repo work.",
  cursor: "@-mention syntax for Cursor's Composer chat.",
  "cline-aider": "Includes the `aider <files>` command + Cline-ready task.",
  "github-issue": "File as a single GitHub Issue with checkbox actions.",
  json: "Structured data for any custom tool / script / dashboard.",
  markdown: "Plain markdown checklist — paste anywhere.",
};

const FORMAT_ICONS: Record<string, string> = {
  "claude-code": "✦",
  cursor: "▲",
  "cline-aider": "⌘",
  "github-issue": "◉",
  json: "{ }",
  markdown: "M↓",
};

export default function AIBuilderHandoff({
  modules,
  repoUrl,
  tier,
  fixFailed,
  fixFailureReason,
}: Props) {
  const findings = useMemo(() => handoff.buildFindings(modules || []), [modules]);
  const c = useMemo(() => handoff.counts(findings), [findings]);
  const availableModules = useMemo(() => {
    const s = new Set<string>();
    for (const f of findings) s.add(f.module);
    return Array.from(s).sort();
  }, [findings]);

  const [format, setFormat] = useState<string>("claude-code");
  const [severity, setSeverity] = useState<"all" | "error" | "warning" | "info">("all");
  const [moduleFilter, setModuleFilter] = useState<string>("all");
  const [query, setQuery] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);

  const filtered = useMemo(
    () =>
      handoff.filterFindings(findings, {
        severity,
        module: moduleFilter,
        query,
      }),
    [findings, severity, moduleFilter, query]
  );

  const rendered = useMemo(
    () => handoff.formatHandoff(format, filtered, { repoUrl, tier }),
    [format, filtered, repoUrl, tier]
  );

  // Auto-clear the "copied!" badge after 1.6s.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  if (findings.length === 0) {
    return null;
  }

  function doCopy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(rendered.content).then(
      () => setCopied(true),
      () => {
        // Fallback: select textarea if present
        const ta = document.getElementById("ai-handoff-textarea") as HTMLTextAreaElement | null;
        if (ta) {
          ta.select();
          try { document.execCommand("copy"); setCopied(true); } catch { /* user can copy manually */ }
        }
      }
    );
  }

  function doDownload() {
    const blob = new Blob([rendered.content], { type: rendered.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = rendered.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function doOpenChatGPT() {
    // Pre-fills a ChatGPT chat with the rendered prompt. ChatGPT URL
    // accepts `?q=` for a starter query.
    const url = `https://chat.openai.com/?q=${encodeURIComponent(rendered.content.slice(0, 4000))}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function doOpenClaudeAi() {
    // claude.ai accepts the new-chat URL; users can paste manually.
    const url = "https://claude.ai/new";
    // Copy first so paste works immediately.
    if (navigator.clipboard) {
      navigator.clipboard.writeText(rendered.content).catch((err) => {
        console.warn("[AIBuilderHandoff] clipboard write failed; user will need to paste manually:", err);
      });
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const lineCount = rendered.content.split("\n").length;
  const charCount = rendered.content.length;
  const fileCount = handoff.groupByFile(filtered).filter(([f]: [string, Finding[]]) => f !== "(unattributed)").length;

  return (
    <div className="rounded-2xl border border-border bg-white overflow-hidden shadow-sm">
      {/* Gradient header bar — AI-native, not 80s */}
      <div
        className="px-5 py-4 border-b border-border relative overflow-hidden"
        style={{
          background:
            "linear-gradient(135deg, rgba(15,118,110,0.08) 0%, rgba(20,184,166,0.04) 50%, rgba(255,255,255,0) 100%)",
        }}
      >
        <div className="flex items-start justify-between flex-wrap gap-3 relative">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold text-white"
                style={{ background: "linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)" }}
                aria-hidden
              >
                ✦
              </span>
              <h3 className="font-bold text-foreground text-sm">
                Send to your AI builder
              </h3>
              <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
                New
              </span>
            </div>
            <p className="text-xs text-muted">
              Hand the {c.total} finding{c.total === 1 ? "" : "s"} to Claude Code, Cursor, Cline, Aider, or any other tool — ready-formatted, no copy-paste cleanup required.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted shrink-0">
            <span className="px-2 py-1 rounded bg-background-alt">{lineCount} lines</span>
            <span className="px-2 py-1 rounded bg-background-alt">{(charCount / 1024).toFixed(1)} KB</span>
          </div>
        </div>

        {/* Honest banner when our own fix path failed */}
        {fixFailed && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs">
            <span className="mt-0.5 text-amber-600" aria-hidden>⚠</span>
            <div className="text-amber-800">
              <span className="font-semibold">Auto-fix didn&rsquo;t complete</span>
              {fixFailureReason ? <> — {fixFailureReason}.</> : <>.</>}{" "}
              Export to your AI builder below and ship the fixes from there. No payment was captured.
            </div>
          </div>
        )}
      </div>

      {/* Format tabs — six pills, current one filled, others outline */}
      <div className="px-5 pt-4 pb-3 border-b border-border bg-background-alt">
        <div className="flex items-center gap-1.5 flex-wrap">
          {handoff.SUPPORTED_FORMATS.map((f) => {
            const active = f === format;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFormat(f)}
                aria-pressed={active}
                title={FORMAT_DESCRIPTIONS[f]}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold transition-all border ${
                  active
                    ? "bg-accent text-white border-accent shadow-sm"
                    : "bg-white text-foreground border-border hover:border-accent hover:text-accent"
                }`}
              >
                <span className="font-mono text-[10px] opacity-80">{FORMAT_ICONS[f]}</span>
                <span>{handoff.FORMAT_LABELS[f]}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted">{FORMAT_DESCRIPTIONS[format]}</p>
      </div>

      {/* Filter row — severity pills + module dropdown + search */}
      <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <SeverityChip
          label="All"
          count={c.total}
          active={severity === "all"}
          onClick={() => setSeverity("all")}
          tone="neutral"
        />
        <SeverityChip
          label="Errors"
          count={c.error}
          active={severity === "error"}
          onClick={() => setSeverity(severity === "error" ? "all" : "error")}
          tone="error"
        />
        <SeverityChip
          label="Warnings"
          count={c.warning}
          active={severity === "warning"}
          onClick={() => setSeverity(severity === "warning" ? "all" : "warning")}
          tone="warning"
        />
        <SeverityChip
          label="Info"
          count={c.info}
          active={severity === "info"}
          onClick={() => setSeverity(severity === "info" ? "all" : "info")}
          tone="info"
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        {availableModules.length > 1 && (
          <select
            value={moduleFilter}
            onChange={(e) => setModuleFilter(e.target.value)}
            className="px-2.5 py-1.5 rounded-full border border-border bg-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          >
            <option value="all">All modules ({availableModules.length})</option>
            {availableModules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search file or message"
          aria-label="Search findings"
          className="flex-1 min-w-[140px] px-3 py-1.5 rounded-full border border-border bg-white text-xs placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        />
        {(severity !== "all" || moduleFilter !== "all" || query) && (
          <button
            type="button"
            onClick={() => {
              setSeverity("all");
              setModuleFilter("all");
              setQuery("");
            }}
            className="text-[11px] font-medium text-muted hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      {/* Selection summary + primary action row */}
      <div className="px-5 py-3 border-b border-border flex items-center justify-between flex-wrap gap-3 bg-white">
        <div className="text-xs text-muted">
          <span className="font-semibold text-foreground">{filtered.length}</span> of {c.total} finding{c.total === 1 ? "" : "s"} selected
          {fileCount > 0 && (
            <> &middot; <span className="font-semibold text-foreground">{fileCount}</span> file{fileCount === 1 ? "" : "s"}</>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border text-foreground bg-white hover:border-accent hover:text-accent transition-colors"
          >
            {previewOpen ? "Hide preview" : "Preview"}
          </button>
          <button
            type="button"
            onClick={doDownload}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border text-foreground bg-white hover:border-accent hover:text-accent transition-colors inline-flex items-center gap-1.5"
            title={`Download ${rendered.filename}`}
          >
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M10 3a1 1 0 011 1v8.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 12.586V4a1 1 0 011-1z" />
              <path d="M3 16a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
            </svg>
            Download
          </button>
          <button
            type="button"
            onClick={doCopy}
            disabled={filtered.length === 0}
            className="px-4 py-1.5 text-xs font-semibold rounded-lg text-white shadow-sm hover:shadow-md transition-all inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: copied
                ? "linear-gradient(135deg, #059669 0%, #10b981 100%)"
                : "linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)",
            }}
          >
            {copied ? (
              <>
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path
                    fillRule="evenodd"
                    d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z"
                    clipRule="evenodd"
                  />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path d="M7 3a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2H7zm0 2h8v10H7V5z" />
                  <path d="M3 7v10a2 2 0 002 2h8v-2H5V7H3z" />
                </svg>
                Copy
              </>
            )}
          </button>
        </div>
      </div>

      {/* Quick-share row — one-tap launchers for the most common targets */}
      <div className="px-5 py-3 border-b border-border bg-background-alt flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Quick send:</span>
        <QuickSend label="Claude.ai" onClick={doOpenClaudeAi} title="Copy + open Claude.ai in a new tab" />
        <QuickSend label="ChatGPT" onClick={doOpenChatGPT} title="Open ChatGPT pre-filled with the prompt" />
        <CopyAndOpen
          label="Cursor"
          onCopy={() => { setFormat("cursor"); setTimeout(doCopy, 0); }}
          title="Format as Cursor task and copy"
        />
        <CopyAndOpen
          label="Cline"
          onCopy={() => { setFormat("cline-aider"); setTimeout(doCopy, 0); }}
          title="Format as Cline / Aider task and copy"
        />
        <CopyAndOpen
          label="GitHub Issue"
          onCopy={() => { setFormat("github-issue"); setTimeout(doCopy, 0); }}
          title="Format as GitHub Issue body and copy"
        />
        {repoUrl && (
          <a
            href={`${normaliseRepoIssuesUrl(repoUrl)}/new?title=${encodeURIComponent("GateTest scan results")}&body=${encodeURIComponent(rendered.content.slice(0, 6000))}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[11px] font-semibold text-accent hover:underline inline-flex items-center gap-1"
            title="Open the new-issue form on the repo with the body pre-filled"
          >
            Open new issue ↗
          </a>
        )}
      </div>

      {/* Preview pane — collapsed by default, opens to a scrolling code block */}
      {previewOpen && (
        <div className="px-5 py-4 bg-background-alt">
          <textarea
            id="ai-handoff-textarea"
            readOnly
            value={rendered.content}
            className="w-full h-[320px] p-3 rounded-lg border border-border bg-white text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30 resize-y whitespace-pre"
            aria-label="Formatted AI builder handoff content"
          />
          <p className="mt-2 text-[11px] text-muted">
            Tip: open <code className="text-foreground font-mono">⌘A</code> +{" "}
            <code className="text-foreground font-mono">⌘C</code> works in this textarea too.
          </p>
        </div>
      )}
    </div>
  );
}

function normaliseRepoIssuesUrl(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
  return `${cleaned}/issues`;
}

function SeverityChip({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone: "neutral" | "error" | "warning" | "info";
}) {
  const palette =
    tone === "error"
      ? active
        ? "bg-red-600 text-white border-red-600"
        : "bg-white text-red-700 border-red-200 hover:border-red-400"
      : tone === "warning"
        ? active
          ? "bg-amber-600 text-white border-amber-600"
          : "bg-white text-amber-700 border-amber-200 hover:border-amber-400"
        : tone === "info"
          ? active
            ? "bg-slate-700 text-white border-slate-700"
            : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
          : active
            ? "bg-foreground text-white border-foreground"
            : "bg-white text-foreground border-border hover:border-accent hover:text-accent";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={count === 0 && tone !== "neutral"}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-colors ${palette} ${count === 0 && tone !== "neutral" ? "opacity-50 cursor-default" : ""}`}
    >
      <span>{label}</span>
      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-white/20 text-[10px] font-bold tabular-nums">
        {count}
      </span>
    </button>
  );
}

function QuickSend({ label, onClick, title }: { label: string; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="px-2.5 py-1 rounded-full text-[11px] font-semibold border border-border bg-white text-foreground hover:border-accent hover:text-accent transition-colors inline-flex items-center gap-1"
    >
      <span aria-hidden>↗</span>
      {label}
    </button>
  );
}

function CopyAndOpen({ label, onCopy, title }: { label: string; onCopy: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      title={title}
      className="px-2.5 py-1 rounded-full text-[11px] font-semibold border border-border bg-white text-foreground hover:border-accent hover:text-accent transition-colors inline-flex items-center gap-1"
    >
      <span aria-hidden>⎘</span>
      {label}
    </button>
  );
}
