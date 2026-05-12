"use client";

/**
 * Phase 6.1.2 — FixSelectionPanel.
 *
 * Lets the customer pick WHICH findings to apply auto-fixes to before
 * triggering the fix loop. Closes the "what if I disagree with one
 * fix?" objection that makes some customers hesitate at $99/$199.
 *
 * Three layers of selection control, top to bottom:
 *   1. Header chips: select-all-fixable / errors-only / warnings-only /
 *      clear. One tap = bulk selection.
 *   2. Per-module summary: "select all 12 secrets findings" buttons.
 *   3. Per-finding checkbox grid grouped by file.
 *
 * The CTA at the bottom shows the live count and triggers the supplied
 * onFix callback with the {file, issue, module}[] payload that
 * /api/scan/fix already accepts.
 *
 * All selection state is LOCAL — selection survives filter changes
 * but resets if `modules` prop reference changes (e.g. on a re-scan).
 */

import { useEffect, useMemo, useState } from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sf = require("@/app/lib/selectable-findings.js") as {
  buildSelectableFindings: (modules: ModuleResult[]) => Selectable[];
  groupSelectableByFile: (findings: Selectable[]) => Array<[string, Selectable[]]>;
  countSelectable: (findings: Selectable[]) => CountSummary;
  selectionForFilter: (
    findings: Selectable[],
    opts?: { severity?: string; module?: string; fixableOnly?: boolean }
  ) => Set<string>;
  selectionToIssueInputs: (
    findings: Selectable[],
    selectedIds: Set<string>
  ) => Array<{ file: string; issue: string; module: string }>;
  selectionCtaLabel: (count: number) => string;
};

interface ModuleResult {
  name: string;
  status: string;
  details?: string[];
}

interface Selectable {
  id: string;
  module: string;
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
  raw: string;
  createFile: boolean;
  fixable: boolean;
}

interface CountSummary {
  total: number;
  fixable: number;
  unfixable: number;
  error: number;
  warning: number;
  info: number;
  byModule: Record<string, number>;
}

interface IssueInput {
  file: string;
  issue: string;
  module: string;
}

interface Props {
  modules: ModuleResult[];
  onFix: (selected: IssueInput[]) => void;
  /** Disable the CTA while a fix is in flight */
  fixing?: boolean;
}

const SEV_BADGE: Record<Selectable["severity"], string> = {
  error: "bg-red-50 text-red-700 border-red-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  info: "bg-slate-50 text-slate-600 border-slate-200",
};

export default function FixSelectionPanel({ modules, onFix, fixing = false }: Props) {
  const findings = useMemo(() => sf.buildSelectableFindings(modules), [modules]);
  const counts = useMemo(() => sf.countSelectable(findings), [findings]);
  const grouped = useMemo(() => sf.groupSelectableByFile(findings), [findings]);

  const [selected, setSelected] = useState<Set<string>>(() => sf.selectionForFilter(findings));

  // Reset selection when the modules array reference changes (re-scan).
  useEffect(() => {
    setSelected(sf.selectionForFilter(findings));
  }, [findings]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFile(fileFindings: Selectable[]) {
    const fixableIds = fileFindings.filter((f) => f.fixable).map((f) => f.id);
    const allSelected = fixableIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of fixableIds) next.delete(id);
      } else {
        for (const id of fixableIds) next.add(id);
      }
      return next;
    });
  }

  function selectByFilter(opts: { severity?: string; module?: string }) {
    setSelected(sf.selectionForFilter(findings, opts));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function fixSelected() {
    const payload = sf.selectionToIssueInputs(findings, selected);
    if (payload.length === 0) return;
    onFix(payload);
  }

  if (counts.fixable === 0 && counts.unfixable === 0) return null;

  const selectedCount = selected.size;
  const selectedFixable = sf.selectionToIssueInputs(findings, selected).length;

  return (
    <div className="rounded-2xl border border-border bg-white overflow-hidden">
      {/* Header */}
      <div
        className="px-5 py-4 border-b border-border"
        style={{
          background:
            "linear-gradient(135deg, rgba(15,118,110,0.06) 0%, rgba(255,255,255,0) 100%)",
        }}
      >
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-bold text-foreground text-sm">Pick the fixes you want</h3>
            <p className="text-xs text-muted mt-0.5">
              <span className="font-semibold text-foreground">{counts.fixable}</span> auto-fixable
              {counts.unfixable > 0 && (
                <> &middot; <span className="text-muted">{counts.unfixable} need manual review</span></>
              )}
              {selectedCount > 0 && (
                <> &middot; <span className="font-semibold text-accent">{selectedFixable}</span> selected</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs flex-wrap">
            <PillButton onClick={() => selectByFilter({})}>All fixable</PillButton>
            {counts.error > 0 && (
              <PillButton onClick={() => selectByFilter({ severity: "error" })}>
                Errors only ({counts.error})
              </PillButton>
            )}
            {counts.warning > 0 && (
              <PillButton onClick={() => selectByFilter({ severity: "warning" })}>
                Warnings ({counts.warning})
              </PillButton>
            )}
            {selectedCount > 0 && (
              <PillButton onClick={clearSelection} muted>
                Clear
              </PillButton>
            )}
          </div>
        </div>
      </div>

      {/* Per-module quick-select */}
      {Object.keys(counts.byModule).length > 1 && (
        <div className="px-5 py-3 border-b border-border bg-background-alt flex items-center gap-1.5 flex-wrap text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-muted mr-1">By module:</span>
          {Object.entries(counts.byModule)
            .sort((a, b) => b[1] - a[1])
            .map(([mod, n]) => (
              <button
                key={mod}
                type="button"
                onClick={() => selectByFilter({ module: mod })}
                className="px-2 py-0.5 rounded-full border border-border bg-white text-foreground hover:border-accent hover:text-accent transition-colors"
              >
                {mod} ({n})
              </button>
            ))}
        </div>
      )}

      {/* Per-file finding grid */}
      <ul className="divide-y divide-border max-h-[420px] overflow-y-auto">
        {grouped.map(([file, fileFindings]) => {
          const fixable = fileFindings.filter((f) => f.fixable);
          const fixableCount = fixable.length;
          const selectedInFile = fixable.filter((f) => selected.has(f.id)).length;
          const allSelected = fixableCount > 0 && selectedInFile === fixableCount;
          const someSelected = selectedInFile > 0 && selectedInFile < fixableCount;
          return (
            <li key={file} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={() => toggleFile(fileFindings)}
                  disabled={fixableCount === 0}
                  aria-label={`Select all ${fixableCount} fixable findings in ${file}`}
                  className="h-3.5 w-3.5 rounded border-border accent-accent"
                />
                <span className="font-mono text-xs text-foreground truncate">{file}</span>
                <span className="text-[10px] text-muted">
                  {fixableCount > 0 && `${selectedInFile}/${fixableCount} fixable`}
                  {fileFindings.length > fixableCount && ` · ${fileFindings.length - fixableCount} manual`}
                </span>
              </div>
              <ul className="ml-5 space-y-1">
                {fileFindings.map((f) => (
                  <li
                    key={f.id}
                    className={`flex items-start gap-2 text-xs ${!f.fixable ? "opacity-60" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(f.id)}
                      onChange={() => toggle(f.id)}
                      disabled={!f.fixable}
                      aria-label={`Select finding ${f.id}: ${f.message}`}
                      className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-accent shrink-0"
                    />
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-1 py-0.5 rounded border shrink-0 ${SEV_BADGE[f.severity]}`}
                    >
                      {f.severity}
                    </span>
                    {f.line && (
                      <span className="font-mono text-muted shrink-0">L{f.line}</span>
                    )}
                    <span className="text-foreground break-words leading-snug">
                      {f.message}
                      {!f.fixable && (
                        <span className="ml-1 text-[10px] text-muted italic">(manual)</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>

      {/* CTA footer */}
      <div className="px-5 py-4 border-t border-border bg-background-alt flex items-center justify-between flex-wrap gap-3">
        <p className="text-xs text-muted">
          {counts.unfixable > 0 && (
            <>
              {counts.unfixable} finding{counts.unfixable === 1 ? "" : "s"} need{counts.unfixable === 1 ? "s" : ""}
              {" "}manual review (no parseable file path) — copy them via the export panel below.
            </>
          )}
        </p>
        <button
          type="button"
          onClick={fixSelected}
          disabled={fixing || selectedFixable === 0}
          className="btn-primary px-5 py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: selectedFixable > 0 && !fixing
              ? "linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)"
              : undefined,
          }}
        >
          {fixing ? "Fixing…" : sf.selectionCtaLabel(selectedFixable)}
        </button>
      </div>
    </div>
  );
}

function PillButton({
  children,
  onClick,
  muted,
}: {
  children: React.ReactNode;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-colors ${
        muted
          ? "bg-white text-muted border-border hover:text-foreground"
          : "bg-white text-foreground border-border hover:border-accent hover:text-accent"
      }`}
    >
      {children}
    </button>
  );
}
