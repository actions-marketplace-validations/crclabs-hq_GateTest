"use client";

/**
 * CopyButton — reusable one-click clipboard component.
 *
 * Three states: idle / pending (mid-copy) / copied (briefly green).
 * Uses navigator.clipboard.writeText with a textarea-select fallback
 * for older browsers / iframe contexts where clipboard API is blocked.
 *
 * Used everywhere we want a customer to be able to grab text:
 *   - Per-finding rows in FindingsPanel
 *   - Code blocks in fix snippets
 *   - LiveScanTerminal output
 *   - PR markdown / report exports
 *
 * Variants:
 *   - "icon" (default) — square 24px button, icon only
 *   - "label" — wider button with "Copy" / "Copied" label
 *   - "inline" — text-button style, sits inline with surrounding text
 *
 * The "what's being copied" label is always announced via aria-label
 * for accessibility (e.g. "Copy file path src/foo.ts:42").
 */

import { useEffect, useState } from "react";

interface Props {
  text: string;
  /** Short description of what's being copied — used in aria-label and toast */
  label?: string;
  /** Visual variant */
  variant?: "icon" | "label" | "inline";
  /** Optional className override */
  className?: string;
  /** Called once after a successful copy (e.g. for analytics) */
  onCopy?: () => void;
  /** Optional title attribute (tooltip on hover) */
  title?: string;
}

type State = "idle" | "pending" | "copied" | "error";

export default function CopyButton({
  text,
  label = "text",
  variant = "icon",
  className = "",
  onCopy,
  title,
}: Props) {
  const [state, setState] = useState<State>("idle");

  useEffect(() => {
    if (state !== "copied" && state !== "error") return;
    const t = setTimeout(() => setState("idle"), 1400);
    return () => clearTimeout(t);
  }, [state]);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (state !== "idle") return;
    setState("pending");
    try {
      const ok = await copyToClipboard(text);
      if (ok) {
        setState("copied");
        if (onCopy) onCopy();
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }

  const aria = state === "copied" ? `${label} copied` : `Copy ${label}`;
  const tooltip = title || aria;

  if (variant === "inline") {
    return (
      <button
        type="button"
        onClick={handleCopy}
        aria-label={aria}
        title={tooltip}
        className={`inline-flex items-center gap-1 text-xs font-medium ${
          state === "copied"
            ? "text-emerald-600"
            : state === "error"
              ? "text-amber-600"
              : "text-muted hover:text-accent"
        } transition-colors ${className}`}
      >
        {state === "copied" ? "✓ Copied" : state === "error" ? "Copy blocked" : "Copy"}
      </button>
    );
  }

  if (variant === "label") {
    return (
      <button
        type="button"
        onClick={handleCopy}
        disabled={state === "pending"}
        aria-label={aria}
        title={tooltip}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
          state === "copied"
            ? "bg-emerald-50 border-emerald-200 text-emerald-700"
            : state === "error"
              ? "bg-amber-50 border-amber-200 text-amber-700"
              : "bg-white border-border text-foreground hover:border-accent hover:text-accent"
        } ${className}`}
      >
        {state === "copied" ? <CheckIcon /> : state === "error" ? <ErrorIcon /> : <ClipboardIcon />}
        <span>
          {state === "copied" ? "Copied" : state === "error" ? "Blocked" : "Copy"}
        </span>
      </button>
    );
  }

  // icon variant (default)
  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={state === "pending"}
      aria-label={aria}
      title={tooltip}
      className={`inline-flex items-center justify-center w-6 h-6 rounded-md border text-xs transition-colors ${
        state === "copied"
          ? "bg-emerald-50 border-emerald-200 text-emerald-700"
          : state === "error"
            ? "bg-amber-50 border-amber-200 text-amber-700"
            : "bg-white border-border text-muted hover:border-accent hover:text-accent"
      } ${className}`}
    >
      {state === "copied" ? <CheckIcon /> : state === "error" ? <ErrorIcon /> : <ClipboardIcon />}
    </button>
  );
}

// ----------------------------------------------------------------------
// clipboard helper — modern API with textarea fallback
// ----------------------------------------------------------------------

/**
 * Exported so non-React callers (e.g. inline onClick handlers in
 * existing components) can use the same logic. Returns true on
 * success, false on failure (don't throw — caller decides UX).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  // Legacy fallback — required for non-HTTPS contexts and older Safari.
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------
// icons (inline so the component has zero external deps)
// ----------------------------------------------------------------------

function ClipboardIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M7 3a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2H7zm0 2h8v10H7V5z" />
      <path d="M3 7v10a2 2 0 002 2h8v-2H5V7H3z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M10 2a8 8 0 100 16 8 8 0 000-16zM9 6a1 1 0 112 0v4a1 1 0 11-2 0V6zm1 8a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}
