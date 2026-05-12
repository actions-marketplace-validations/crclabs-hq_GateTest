"use client";

import { useMemo, useState } from "react";
import CopyButton from "./CopyButton";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatFindingsAsMarkdown, formatFindingAsLine } = require("@/app/lib/copy-formatters.js") as {
  formatFindingsAsMarkdown: (opts: { findings: unknown[]; totalCount?: number; repoUrl?: string }) => string;
  formatFindingAsLine: (f: { severity: string; module: string; file?: string | null; line?: number | null; message?: string }) => string;
};

interface ModuleResult {
  name: string;
  status: "passed" | "failed" | "skipped" | "pending" | "running";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
}

export interface Finding {
  id: string;
  module: string;
  moduleLabel: string;
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
  raw: string;
}

type SeverityFilter = "all" | "error" | "warning" | "info";

const MODULE_LABELS: Record<string, string> = {
  syntax: "Syntax",
  lint: "Lint",
  secrets: "Secrets",
  codeQuality: "Code quality",
  security: "Security",
  accessibility: "Accessibility",
  seo: "SEO",
  links: "Links",
  compatibility: "Compatibility",
  dataIntegrity: "Data integrity",
  documentation: "Documentation",
  performance: "Performance",
  aiReview: "AI review",
  fakeFixDetector: "Fake-fix detector",
};

const WARNING_HINTS = /\b(warning|warn|should|consider|prefer|outdated|stale|deprecat|missing|unused|aging)\b/i;
const INFO_HINTS = /\b(summary|ok|note|scanned|info|library-ok)\b/i;
const ERROR_HINTS = /\b(error|fail|vulnerab|exploit|injection|unsafe|critical|leak|exposed|disabled|bypass|impossible|catastrophic|unbounded|never|race|toctou|secret|credential|password|api[_-]?key|token)\b/i;

function classifySeverity(raw: string): Finding["severity"] {
  const lower = raw.toLowerCase();
  // Explicit prefix wins
  if (/^(error|err|critical|high)\b[:]/i.test(raw)) return "error";
  if (/^(warning|warn|medium)\b[:]/i.test(raw)) return "warning";
  if (/^(info|note|low|summary)\b[:]/i.test(raw)) return "info";
  if (ERROR_HINTS.test(lower)) return "error";
  if (WARNING_HINTS.test(lower)) return "warning";
  if (INFO_HINTS.test(lower)) return "info";
  return "warning";
}

function parseFinding(
  raw: string,
  moduleName: string,
  index: number
): Finding {
  // Strip leading severity/tag prefixes like "error:" or "[warning]"
  let rest = raw.replace(/^(?:\[[^\]]+\]\s*|(?:error|warn(?:ing)?|info|note|summary)\s*:\s*)/i, "").trim();

  let file: string | null = null;
  let line: number | null = null;

  // Match patterns like "path/to/file.ts:42" or "path/to/file.ts:42:7"
  const fileLineMatch = rest.match(/^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8}):(\d+)(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/);
  if (fileLineMatch) {
    file = fileLineMatch[1];
    line = Number(fileLineMatch[2]);
    rest = fileLineMatch[3];
  } else {
    // Match "path/to/file.ts: message" (no line)
    const fileOnly = rest.match(/^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8})\s*[:—-]\s*(.+)$/);
    if (fileOnly) {
      file = fileOnly[1];
      rest = fileOnly[2];
    }
  }

  return {
    id: `${moduleName}-${index}`,
    module: moduleName,
    moduleLabel: MODULE_LABELS[moduleName] || moduleName,
    severity: classifySeverity(raw),
    file,
    line,
    message: rest.trim(),
    raw,
  };
}

export function buildFindings(modules: ModuleResult[]): Finding[] {
  const out: Finding[] = [];
  for (const m of modules) {
    if (!m.details || m.details.length === 0) continue;
    m.details.forEach((d, idx) => {
      out.push(parseFinding(d, m.name, idx));
    });
  }
  return out;
}

const SEV_BADGE: Record<Finding["severity"], string> = {
  error: "bg-red-50 text-red-700 border-red-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  info: "bg-slate-50 text-slate-600 border-slate-200",
};

const SEV_DOT: Record<Finding["severity"], string> = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-slate-400",
};

const SEV_BAR: Record<Finding["severity"], string> = {
  error: "border-l-red-500",
  warning: "border-l-amber-500",
  info: "border-l-slate-400",
};

interface Props {
  modules: ModuleResult[];
  repoUrl?: string;
}

export default function FindingsPanel({ modules, repoUrl }: Props) {
  const findings = useMemo(() => buildFindings(modules), [modules]);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [moduleFilter, setModuleFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  // Phase 5.2.1 — dissent state. Tracked per-finding-id so the panel
  // can show a "thanks, recorded" indicator and prevent double-submits.
  const [dissentedIds, setDissentedIds] = useState<Set<string>>(() => new Set());
  const [pendingDissentId, setPendingDissentId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0, total: findings.length };
    for (const f of findings) c[f.severity]++;
    return c;
  }, [findings]);

  const availableModules = useMemo(() => {
    const s = new Set<string>();
    for (const f of findings) s.add(f.module);
    return Array.from(s);
  }, [findings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter((f) => {
      if (severityFilter !== "all" && f.severity !== severityFilter) return false;
      if (moduleFilter !== "all" && f.module !== moduleFilter) return false;
      if (q) {
        const hay = `${f.file || ""} ${f.message} ${f.moduleLabel}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [findings, severityFilter, moduleFilter, query]);

  const repoBase = useMemo(() => {
    if (!repoUrl) return null;
    const m = repoUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/);
    return m ? `https://github.com/${m[1]}/blob/HEAD` : null;
  }, [repoUrl]);

  // Phase 5.2.1 — dissent thumbs-down. Records a FALSE_POSITIVE dissent
  // so the 5.2.2 FP scorer can downgrade noisy modules. State is local
  // (per-finding) so the button shows immediate feedback without
  // re-fetching. Failures fall silent so a brain outage doesn't break
  // the panel.
  async function handleDissent(f: Finding) {
    if (dissentedIds.has(f.id) || pendingDissentId === f.id) return;
    setPendingDissentId(f.id);
    try {
      const res = await fetch("/api/dissent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: repoUrl || "",
          module: f.module,
          // The findings panel doesn't have the (module, ruleId, ext)
          // pattern hash on hand — use the finding's stable id as a
          // fallback signature. The 5.2.2 scorer treats null
          // patternHash as "module-level" and aggregates accordingly.
          patternHash: null,
          kind: "false_positive",
          notes: f.message?.slice(0, 200),
        }),
      });
      if (res.ok) {
        setDissentedIds((s) => {
          const next = new Set(s);
          next.add(f.id);
          return next;
        });
      }
    } catch {
      // Brain unavailable — never block the panel.
    } finally {
      setPendingDissentId(null);
    }
  }

  // Universal-copy helper — formats the currently-filtered findings as a
  // markdown checklist the customer can paste into any AI builder /
  // ticket / Slack thread. Backed by the shared formatter so the same
  // shape ships across panels and is unit-tested separately. Hook MUST
  // live before any conditional return — Rules of Hooks require a stable
  // call order across renders.
  const bulkCopyText = useMemo(
    () => formatFindingsAsMarkdown({ findings: filtered, totalCount: counts.total, repoUrl }),
    [filtered, counts.total, repoUrl]
  );

  if (findings.length === 0) {
    return (
      <div className="rounded-2xl border border-green-200 bg-green-50/60 p-8 text-center celebrate">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100 text-success text-xl font-bold mb-3">
          ✓
        </div>
        <p className="font-bold text-foreground text-lg">All clear.</p>
        <p className="text-sm text-muted mt-1">
          No findings across {modules.length} module{modules.length === 1 ? "" : "s"}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-white overflow-hidden">
      {/* Header bar */}
      <div className="px-5 py-4 border-b border-border bg-background-alt">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-foreground text-sm">Findings</h3>
            <p className="text-xs text-muted mt-0.5">
              {counts.total} total &middot; {filtered.length} shown
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {filtered.length > 0 && (
              <CopyButton
                text={bulkCopyText}
                label={`${filtered.length} findings as markdown`}
                variant="label"
                title={`Copy all ${filtered.length} shown findings as a markdown checklist`}
              />
            )}
            <SevPill
              label="Errors"
              count={counts.error}
              active={severityFilter === "error"}
              onClick={() => setSeverityFilter(severityFilter === "error" ? "all" : "error")}
              tone="error"
            />
            <SevPill
              label="Warnings"
              count={counts.warning}
              active={severityFilter === "warning"}
              onClick={() => setSeverityFilter(severityFilter === "warning" ? "all" : "warning")}
              tone="warning"
            />
            <SevPill
              label="Info"
              count={counts.info}
              active={severityFilter === "info"}
              onClick={() => setSeverityFilter(severityFilter === "info" ? "all" : "info")}
              tone="info"
            />
          </div>
        </div>

        {/* Filters */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search file or message"
              aria-label="Search findings"
              className="w-full px-3 py-2 pl-8 rounded-lg border border-border bg-white text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            />
            <svg
              className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden
            >
              <path
                fillRule="evenodd"
                d="M8 4a4 4 0 100 8 4 4 0 000-8zm-6 4a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          {availableModules.length > 1 && (
            <select
              value={moduleFilter}
              onChange={(e) => setModuleFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            >
              <option value="all">All modules</option>
              {availableModules.map((m) => (
                <option key={m} value={m}>
                  {MODULE_LABELS[m] || m}
                </option>
              ))}
            </select>
          )}
          {(severityFilter !== "all" || moduleFilter !== "all" || query) && (
            <button
              type="button"
              onClick={() => {
                setSeverityFilter("all");
                setModuleFilter("all");
                setQuery("");
              }}
              className="px-3 py-2 text-xs text-muted hover:text-foreground font-medium"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted">
          No findings match the current filter.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {filtered.map((f) => {
            const href =
              f.file && repoBase
                ? `${repoBase}/${f.file.replace(/^\/+/, "")}${f.line ? `#L${f.line}` : ""}`
                : null;
            const fileLine = f.file
              ? f.line
                ? `${f.file}:${f.line}`
                : f.file
              : null;
            return (
              <li
                key={f.id}
                className={`pl-4 pr-5 py-3 border-l-4 ${SEV_BAR[f.severity]} hover:bg-background-alt transition-colors group`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${SEV_DOT[f.severity]}`}
                    aria-hidden
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${SEV_BADGE[f.severity]}`}
                      >
                        {f.severity}
                      </span>
                      <span className="text-[11px] font-medium text-muted uppercase tracking-wide">
                        {f.moduleLabel}
                      </span>
                      {fileLine && (
                        <span className="inline-flex items-center gap-1 text-xs font-mono text-foreground-secondary">
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-accent hover:underline"
                            >
                              {fileLine}
                            </a>
                          ) : (
                            fileLine
                          )}
                          <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <CopyButton
                              text={fileLine}
                              label={`file path ${fileLine}`}
                              variant="icon"
                            />
                          </span>
                        </span>
                      )}
                      {/* Per-row Copy-as-finding-text — always visible at edge */}
                      <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                        <CopyButton
                          text={formatFindingAsLine(f)}
                          label="finding"
                          variant="icon"
                          title="Copy this finding as text"
                        />
                      </span>
                    </div>
                    <p className="text-sm text-foreground leading-snug break-words">
                      {f.message}
                    </p>
                  </div>
                  {/* Phase 5.2.1 — false-positive thumbs-down. Records a dissent
                      signal that flows into the per-module FP scorer in 5.2.2 */}
                  <button
                    type="button"
                    onClick={() => handleDissent(f)}
                    disabled={dissentedIds.has(f.id) || pendingDissentId === f.id}
                    className={`shrink-0 self-start mt-1 ml-2 inline-flex items-center justify-center w-6 h-6 rounded-md border text-xs transition-colors ${
                      dissentedIds.has(f.id)
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700 cursor-default"
                        : pendingDissentId === f.id
                          ? "bg-background-alt border-border text-muted cursor-wait"
                          : "bg-white border-border text-muted hover:border-amber-300 hover:text-amber-700 hover:bg-amber-50"
                    }`}
                    title={
                      dissentedIds.has(f.id)
                        ? "Recorded as false positive — thanks, this signal feeds the brain"
                        : pendingDissentId === f.id
                          ? "Recording…"
                          : "This is a false positive — flag for the brain"
                    }
                    aria-label="Mark as false positive"
                  >
                    {dissentedIds.has(f.id) ? (
                      <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                        <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
                      </svg>
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SevPill({
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
  tone: "error" | "warning" | "info";
}) {
  const base =
    tone === "error"
      ? active
        ? "bg-red-600 text-white border-red-600"
        : "bg-white text-red-700 border-red-200 hover:border-red-400"
      : tone === "warning"
        ? active
          ? "bg-amber-600 text-white border-amber-600"
          : "bg-white text-amber-700 border-amber-200 hover:border-amber-400"
        : active
          ? "bg-slate-700 text-white border-slate-700"
          : "bg-white text-slate-600 border-slate-200 hover:border-slate-400";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold transition-colors ${base} ${count === 0 ? "opacity-50 cursor-default" : ""}`}
      disabled={count === 0}
      aria-pressed={active}
    >
      <span>{label}</span>
      <span
        className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums ${active ? "bg-white/20" : "bg-background-alt"}`}
      >
        {count}
      </span>
    </button>
  );
}
