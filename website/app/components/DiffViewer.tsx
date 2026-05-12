"use client";

/**
 * Phase 6.1.3 — DiffViewer.
 *
 * Renders a (before, after) pair as a compact unified-style diff with
 * syntax-coloured + and - lines. Used wherever we want the customer
 * to SEE the patch, not just read about it.
 *
 * Used by:
 *   - /scan/status fix-result section (so $99 customers without a PR
 *     still see the proposed fixes)
 *   - The AI-Builder Handoff "diff" export
 *   - Any future per-finding "preview this fix" surface
 *
 * The actual diff math is in `app/lib/inline-diff.js` so the same
 * algorithm runs in tests, in this UI, and in the PR-composer.
 */

import { useMemo, useState } from "react";
import CopyButton from "./CopyButton";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const inlineDiff = require("@/app/lib/inline-diff.js") as {
  computeInlineDiff: (
    oldText: string,
    newText: string,
    opts?: { contextLines?: number }
  ) => DiffResult;
  renderUnifiedDiff: (r: DiffResult, opts?: { oldName?: string; newName?: string }) => string;
  summariseDiff: (r: DiffResult) => string;
};

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ type: "context" | "add" | "remove"; text: string }>;
}

interface DiffResult {
  hunks: Hunk[];
  oversize: boolean;
  identical: boolean;
}

interface Props {
  /** File path / label shown at the top of the diff card */
  fileLabel: string;
  /** Original file content */
  before: string;
  /** Fixed file content */
  after: string;
  /** Optional list of finding texts that motivated this fix */
  issues?: string[];
  /** Default-collapsed for big diffs; opt-in expand */
  defaultCollapsed?: boolean;
}

export default function DiffViewer({
  fileLabel,
  before,
  after,
  issues,
  defaultCollapsed = false,
}: Props) {
  const diff = useMemo(() => inlineDiff.computeInlineDiff(before, after), [before, after]);
  const summary = useMemo(() => inlineDiff.summariseDiff(diff), [diff]);
  const unifiedText = useMemo(
    () => inlineDiff.renderUnifiedDiff(diff, { oldName: `a/${fileLabel}`, newName: `b/${fileLabel}` }),
    [diff, fileLabel]
  );
  const [expanded, setExpanded] = useState(!defaultCollapsed);

  if (diff.identical) {
    return (
      <div className="rounded-xl border border-border bg-white px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="font-mono text-foreground">{fileLabel}</span>
          <span>— no changes</span>
        </div>
      </div>
    );
  }

  if (diff.oversize) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs">
        <span className="font-mono text-foreground">{fileLabel}</span>
        <span className="text-amber-700 ml-2">— file too large for inline diff (open the PR for the full patch)</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-white overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border bg-background-alt flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? `Collapse diff for ${fileLabel}` : `Expand diff for ${fileLabel}`}
            className="text-muted hover:text-accent transition-colors text-xs font-mono"
          >
            {expanded ? "▼" : "▶"}
          </button>
          <span className="font-mono text-xs text-foreground truncate">{fileLabel}</span>
          <span className="text-[11px] text-muted">{summary}</span>
        </div>
        <CopyButton
          text={unifiedText}
          label={`unified diff for ${fileLabel}`}
          variant="icon"
          title="Copy unified diff (paste into git apply / PR comments)"
        />
      </div>

      {/* Per-finding context — what motivated this fix */}
      {expanded && issues && issues.length > 0 && (
        <div className="px-4 py-2 border-b border-border bg-background-alt/40">
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
            Issues addressed ({issues.length})
          </p>
          <ul className="space-y-0.5">
            {issues.map((iss, i) => (
              <li key={i} className="text-xs text-foreground leading-snug">
                <span className="text-muted">→</span> {iss}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Hunks */}
      {expanded && (
        <div className="font-mono text-xs overflow-x-auto">
          {diff.hunks.map((h, hi) => (
            <div key={hi} className="border-t border-border first:border-t-0">
              <div className="px-4 py-1 text-[11px] text-muted bg-background-alt/40">
                @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
              </div>
              {h.lines.map((l, li) => (
                <div
                  key={li}
                  className={`px-4 py-0.5 leading-snug whitespace-pre ${
                    l.type === "add"
                      ? "bg-emerald-50 text-emerald-900"
                      : l.type === "remove"
                        ? "bg-red-50 text-red-900"
                        : "text-foreground"
                  }`}
                >
                  <span className="select-none text-muted mr-2">
                    {l.type === "add" ? "+" : l.type === "remove" ? "-" : " "}
                  </span>
                  {l.text || " "}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
