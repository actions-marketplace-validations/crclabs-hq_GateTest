"use client";

/**
 * <ChatWidget />
 *
 * Floating bottom-right chat button that expands into a full chat
 * window. Powered by /api/chat, which calls Claude scoped to GateTest
 * product knowledge. No phone, no human handoff — this is the entire
 * support channel.
 *
 * Design rules:
 *   - Discreet idle state: small circular button, doesn't block content
 *   - Mobile: full-bleed sheet on small screens; floating panel on
 *     desktop (max 400px wide × 600px tall)
 *   - Conversation persisted in localStorage so refresh doesn't lose it
 *   - Streaming token-by-token typing effect (looks alive)
 *   - "AI agent" disclosed up-front (Bible: never pretend to be human)
 *   - Send on Enter, Shift+Enter for newline
 *   - Auto-scroll to latest message
 *   - Empty state suggests three starter prompts
 *
 * Accessibility:
 *   - Button has aria-label
 *   - Open state traps focus inside the panel via the standard tab
 *     loop (no aria-modal — chat is non-blocking)
 *   - aria-live="polite" on the message list so screen readers
 *     announce streaming responses without spam
 *   - Escape closes the panel
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Role = "user" | "assistant";
interface Message {
  role: Role;
  content: string;
}

const STORAGE_KEY = "gatetest-chat-history-v1";
const STARTER_PROMPTS = [
  "What's the difference between Quick Scan and Full Scan?",
  "How do I scan my WordPress site?",
  "Do you check for broken links?",
];

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [streamingReply, setStreamingReply] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Restore history from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setMessages(parsed.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"));
        }
      }
    } catch { /* corrupted history — start fresh */ }
  }, []);

  // Persist history whenever it changes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages)); } catch { /* quota / private mode */ }
  }, [messages]);

  // Auto-scroll to latest message.
  useEffect(() => {
    if (open) messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamingReply, open]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // When the panel opens, focus the textarea (after the open animation
  // gives it a tick to mount).
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [open]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isThinking) return;
    setError(null);
    const newHistory: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(newHistory);
    setDraft("");
    setIsThinking(true);
    setStreamingReply("");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newHistory }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        let detail = "";
        try { const j = await res.json(); detail = j?.error || ""; } catch { /* ignore */ }
        throw new Error(detail || `Request failed (HTTP ${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "message";
      let currentData = "";
      let accumulated = "";
      const flush = () => {
        if (!currentData) { currentEvent = "message"; return; }
        try {
          const parsed = JSON.parse(currentData);
          if (currentEvent === "token" && parsed?.text) {
            accumulated += parsed.text;
            setStreamingReply(accumulated);
          } else if (currentEvent === "error" && parsed?.error) {
            setError(String(parsed.error));
          }
        } catch { /* malformed event */ }
        currentEvent = "message";
        currentData = "";
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) { if (currentData) flush(); break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith(":")) continue;
          if (line === "") { flush(); continue; }
          if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
          else if (line.startsWith("data:")) currentData += (currentData ? "\n" : "") + line.slice(5).trim();
        }
      }

      setMessages((prev) => [...prev, { role: "assistant", content: accumulated || "I didn't quite catch that — could you rephrase?" }]);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // user closed the panel mid-stream
      } else {
        const msg = err instanceof Error ? err.message : "Network error reaching the chat agent.";
        setError(msg);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Sorry — I'm having trouble responding right now. ${msg} Try again in a moment; these are usually transient.` },
        ]);
      }
    } finally {
      setIsThinking(false);
      setStreamingReply("");
      abortRef.current = null;
    }
  }, [messages, isThinking]);

  const reset = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    setMessages([]);
    setDraft("");
    setError(null);
    setStreamingReply("");
    setIsThinking(false);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  function onTextareaKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  }

  return (
    <>
      {/* Floating launcher button */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open chat support"
          className="fixed bottom-5 right-5 z-50 inline-flex items-center justify-center w-14 h-14 rounded-full bg-accent text-white shadow-lg hover:bg-accent-hover transition-all focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/30 sm:bottom-6 sm:right-6"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div
          className="fixed inset-0 sm:inset-auto sm:bottom-6 sm:right-6 z-50 sm:w-[400px] sm:max-w-[calc(100vw-2rem)] sm:h-[600px] sm:max-h-[calc(100vh-3rem)] bg-background border border-border sm:rounded-2xl shadow-2xl flex flex-col"
          role="dialog"
          aria-label="GateTest support chat"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background-alt sm:rounded-t-2xl">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent/15 text-accent" aria-hidden>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </span>
              <div>
                <p className="font-semibold text-foreground leading-tight">GateTest Support</p>
                <p className="text-xs text-muted">AI agent — answers in seconds</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={reset}
                  className="text-xs text-muted hover:text-foreground transition-colors p-2 focus:outline-none focus-visible:underline"
                  aria-label="Clear conversation"
                  title="Clear conversation"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close chat"
                className="p-2 rounded-lg text-muted hover:text-foreground hover:bg-border/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" aria-live="polite" aria-atomic="false">
            {messages.length === 0 && !isThinking && (
              <div className="space-y-4">
                <p className="text-sm text-foreground leading-relaxed">
                  Hi — I&apos;m the GateTest AI support agent. I can answer questions about
                  scans, pricing, modules, and how the product works.
                </p>
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 leading-relaxed">
                  <p className="font-semibold mb-0.5">I&apos;m AI — I can be wrong.</p>
                  <p>
                    If my answer doesn&apos;t match what you see in product, trust the
                    product. For pricing and policies, the source of truth is the{" "}
                    <a href="/legal/terms" className="underline">legal pages</a>.
                  </p>
                </div>
                <p className="text-xs text-muted">Pick a starter question or type your own:</p>
                <div className="space-y-2">
                  {STARTER_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => send(p)}
                      className="block w-full text-left text-sm px-3 py-2 rounded-lg border border-border bg-background hover:border-accent hover:bg-accent/5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <MessageBubble key={i} speaker={m.role} content={m.content} />
            ))}

            {/* Streaming assistant reply — appears while tokens arrive */}
            {isThinking && (
              <MessageBubble
                speaker="assistant"
                content={streamingReply || ""}
                streaming
              />
            )}

            {error && (
              <p className="text-xs text-rose-600 mt-2">
                Last request failed: {error}. Try sending your message again — these are usually transient.
              </p>
            )}

            <div ref={messagesEndRef} aria-hidden />
          </div>

          {/* Input */}
          <div className="border-t border-border p-3 sm:rounded-b-2xl bg-background">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onTextareaKey}
                rows={1}
                placeholder="Ask about GateTest..."
                disabled={isThinking}
                className="flex-1 resize-none px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-50 max-h-32"
                aria-label="Message"
              />
              <button
                type="button"
                onClick={() => send(draft)}
                disabled={!draft.trim() || isThinking}
                className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                aria-label="Send message"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
            <p className="text-[10px] text-muted mt-2 text-center">
              I&apos;m AI — I can get things wrong. For pricing and policies, the source of truth is the{" "}
              <a href="/legal/terms" className="underline">legal pages</a>. For everything else, run a scan to see the real answer.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function MessageBubble({ speaker, content, streaming = false }: { speaker: Role; content: string; streaming?: boolean }) {
  const isUser = speaker === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-accent text-white rounded-br-sm"
            : "bg-background-alt text-foreground border border-border rounded-bl-sm"
        }`}
      >
        {content}
        {streaming && (
          <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 align-middle" aria-hidden />
        )}
      </div>
    </div>
  );
}
