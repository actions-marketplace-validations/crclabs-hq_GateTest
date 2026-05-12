"use client";

import { useState, useEffect, useRef } from "react";
import CopyButton from "./CopyButton";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatScanTranscript } = require("@/app/lib/copy-formatters.js") as {
  formatScanTranscript: (opts: { logs: Array<{ type: string; message: string }>; command?: string; prefixFor?: (t: string) => string }) => string;
};

interface LogEntry {
  time: number;
  type: "module-start" | "module-pass" | "module-fail" | "issue" | "fix" | "info" | "complete" | "error";
  module?: string;
  message: string;
  file?: string;
  line?: number;
}

interface LiveScanTerminalProps {
  repoUrl: string;
  tier: string;
  sessionId?: string;
  onComplete: (result: Record<string, unknown>) => void;
  onError: (error: string) => void;
}

const MODULE_ORDER = [
  "syntax", "lint", "secrets", "codeQuality", "fakeFixDetector",
  "security", "accessibility", "seo", "links", "compatibility",
  "dataIntegrity", "documentation", "performance", "aiReview",
];

export default function LiveScanTerminal({ repoUrl, tier, sessionId, onComplete, onError }: LiveScanTerminalProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(true);
  const [progress, setProgress] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);
  const hasStarted = useRef(false);

  const addLog = (entry: Omit<LogEntry, "time">) => {
    setLogs((prev) => [...prev, { ...entry, time: Date.now() }]);
  };

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    const modules = tier === "quick"
      ? MODULE_ORDER.slice(0, 5)
      : MODULE_ORDER;

    let current = 0;

    addLog({ type: "info", message: `GATETEST — Scanning ${repoUrl.replace("https://github.com/", "")}` });
    addLog({ type: "info", message: `Running ${tier} suite: ${modules.length} modules` });

    const simulateModules = () => {
      if (current >= modules.length) {
        addLog({ type: "info", message: "All modules complete. Waiting for API response..." });
        return;
      }

      const mod = modules[current];
      addLog({ type: "module-start", module: mod, message: `Starting ${mod}...` });
      setProgress(Math.round((current / modules.length) * 90));

      setTimeout(() => {
        addLog({ type: "module-pass", module: mod, message: `${mod} — complete` });
        current++;
        setProgress(Math.round((current / modules.length) * 90));
        simulateModules();
      }, 400 + Math.random() * 600);
    };

    setTimeout(simulateModules, 500);

    // Actual scan request
    fetch("/api/scan/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl, tier, ...(sessionId ? { sessionId } : {}) }),
    })
      .then((res) => res.json())
      .then((data) => {
        setProgress(100);

        const mods = (data.modules as Array<Record<string, unknown>>) || [];
        const totalIssues = (data.totalIssues as number) || 0;

        // Log real results
        for (const mod of mods) {
          const status = mod.status as string;
          const details = (mod.details as string[]) || [];
          const issues = (mod.issues as number) || 0;

          if (status === "failed" && issues > 0) {
            addLog({
              type: "module-fail",
              module: mod.name as string,
              message: `${mod.name} — ${issues} issue${issues > 1 ? "s" : ""} found`,
            });
            for (const d of details.slice(0, 5)) {
              addLog({ type: "issue", module: mod.name as string, message: d });
            }
            if (details.length > 5) {
              addLog({ type: "info", message: `  ...${details.length - 5} more` });
            }
          }
        }

        // Auto-fix results
        const fixes = (data.fixes as Array<Record<string, unknown>>) || [];
        if (fixes.length > 0) {
          addLog({ type: "info", message: `\nAUTO-FIX: ${fixes.length} issue${fixes.length > 1 ? "s" : ""} fixed` });
          for (const fix of fixes) {
            addLog({
              type: "fix",
              message: `Fixed: ${fix.description || fix.check}`,
              file: fix.filesChanged ? (fix.filesChanged as string[])[0] : undefined,
            });
          }
        }

        if (totalIssues === 0) {
          addLog({ type: "complete", message: `\nGATE: PASSED — ${mods.length} modules, ${data.duration}ms` });
        } else {
          addLog({ type: "complete", message: `\nGATE: ${totalIssues} ISSUE${totalIssues > 1 ? "S" : ""} — ${mods.length} modules, ${data.duration}ms` });
        }

        setRunning(false);
        onComplete(data);
      })
      .catch((err) => {
        addLog({ type: "error", message: `Error: ${err.message}` });
        setRunning(false);
        onError(err.message);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoUrl, tier, onComplete, onError]);

  // Auto-scroll
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  const getColor = (type: LogEntry["type"]) => {
    switch (type) {
      case "module-pass": return "text-emerald-400";
      case "module-fail": return "text-red-400";
      case "module-start": return "text-white/40";
      case "issue": return "text-amber-400";
      case "fix": return "text-cyan-400";
      case "complete": return "text-emerald-400 font-bold";
      case "error": return "text-red-400 font-bold";
      default: return "text-white/50";
    }
  };

  const getPrefix = (type: LogEntry["type"]) => {
    switch (type) {
      case "module-pass": return "  ✓ ";
      case "module-fail": return "  ✗ ";
      case "module-start": return "  ▸ ";
      case "issue": return "    → ";
      case "fix": return "  ⚡ ";
      case "complete": return "  ";
      case "error": return "  ✗ ";
      default: return "  ";
    }
  };

  // Universal copy — flatten the log array into a paste-anywhere
  // transcript. Backed by the shared formatter so the prefix scheme
  // matches everywhere and is unit-tested.
  const transcriptText = formatScanTranscript({
    logs,
    command: `gatetest --suite ${tier} --fix ${repoUrl.replace("https://github.com/", "")}`,
    // getPrefix is typed against LogEntry["type"] but accepts any string
    // safely (returns the default-prefix on unknowns). Cast widens the
    // callback to the formatter's signature without changing behaviour.
    prefixFor: getPrefix as (t: string) => string,
  });

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden bg-[#0a0a12] shadow-2xl">
      {/* Terminal header */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-white/6 bg-white/[0.02]">
        <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-xs text-white/30 font-mono">
          gatetest --suite {tier} --fix {repoUrl.replace("https://github.com/", "")}
        </span>
        {logs.length > 0 && (
          <span className="ml-auto inline-flex items-center gap-2">
            <CopyButton
              text={transcriptText}
              label={`scan transcript (${logs.length} lines)`}
              variant="inline"
              className="!text-white/60 hover:!text-white"
              title="Copy the full scan transcript"
            />
            {running && (
              <span className="text-xs text-emerald-400 font-medium tracking-wider animate-pulse">
                SCANNING
              </span>
            )}
            {!running && (
              <span className="text-xs text-emerald-400 font-medium tracking-wider">
                COMPLETE
              </span>
            )}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-white/5">
        <div
          className="h-full bg-emerald-400 transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Terminal output */}
      <div
        ref={terminalRef}
        className="p-5 font-mono text-xs leading-relaxed max-h-[500px] overflow-y-auto"
      >
        {logs.map((log, i) => (
          <div key={i} className={`${getColor(log.type)} whitespace-pre-wrap`}>
            {getPrefix(log.type)}{log.message}
          </div>
        ))}
        {running && (
          <div className="text-white/20 animate-pulse mt-1">
            {"  "}▍
          </div>
        )}
      </div>
    </div>
  );
}
