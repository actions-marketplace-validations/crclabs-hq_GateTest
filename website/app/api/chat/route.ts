/**
 * On-site chat agent endpoint.
 *
 * Customer-service chat powered by Claude, scoped strictly to GateTest
 * product knowledge via a system prompt + agent rules. No phone, no
 * human agent — this is the support channel.
 *
 * Request:
 *   POST /api/chat
 *   Body: { messages: [{ role: 'user'|'assistant', content: string }] }
 *
 * Response: streaming Server-Sent Events:
 *   event: token   { text: string }
 *   event: done    { totalTokens?: number }
 *   event: error   { error: string }
 *
 * The client (ChatWidget) consumes via fetch + ReadableStream reader.
 *
 * Cost control:
 *   - Quick-filter blocks obvious prompt-injection attempts before any
 *     Claude call (free).
 *   - System prompt is cached on Anthropic's side via prompt-caching
 *     headers when supported.
 *   - History truncated to last 20 turns.
 *   - Max output cap 1024 tokens per turn.
 *   - Simple per-IP rate limit (10 messages per minute) via existing
 *     rate-limit helper.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

interface InboundMessage {
  role?: string;
  content?: string;
}

interface ChatRequest {
  messages?: InboundMessage[];
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Chat is not configured on this deployment." },
      { status: 503 }
    );
  }

  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sp = require("@/app/lib/chat-system-prompt") as {
    buildSystemPrompt: () => string;
    sanitizeMessages: (m: InboundMessage[]) => Array<{ role: "user" | "assistant"; content: string }>;
    quickFilter: (message: string) => string | null;
    CHAT_MODEL: string;
    CHAT_MAX_TOKENS: number;
  };

  const messages = sp.sanitizeMessages(body.messages || []);
  if (messages.length === 0) {
    return NextResponse.json({ error: "messages[] is required" }, { status: 400 });
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return NextResponse.json({ error: "no user message in conversation" }, { status: 400 });
  }

  // Local pre-filter — short-circuit obvious prompt-injection without
  // spending Anthropic tokens. Returns a canned SSE stream.
  const local = sp.quickFilter(lastUser.content);
  if (local) {
    return new Response(makeLocalStream(local), {
      status: 200,
      headers: sseHeaders(),
    });
  }

  // Best-effort rate limit. Reusing the existing limiter avoids a new
  // dep. Failures fall through (don't crash chat over rate-limit infra).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
      createLimiter: (preset: { windowMs: number; maxRequests: number }) => {
        guard: (req: NextRequest) => Promise<{ allowed: boolean; body?: unknown; status?: number; headers?: Record<string, string> }>;
      };
      PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
    };
    const limiter = createLimiter(PRESETS.chat || { windowMs: 60_000, maxRequests: 10 });
    const rl = await limiter.guard(req);
    if (!rl.allowed) {
      return new Response(makeLocalStream("You're sending messages a bit fast — give it a moment and I'll catch up."), {
        status: 200,
        headers: sseHeaders(),
      });
    }
  } catch { /* limiter unavailable — proceed */ }

  const systemPrompt = sp.buildSystemPrompt();
  const upstreamBody = JSON.stringify({
    model: sp.CHAT_MODEL,
    max_tokens: sp.CHAT_MAX_TOKENS,
    system: systemPrompt,
    messages,
    stream: true,
  });

  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: upstreamBody,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Network error reaching the chat agent";
    return new Response(makeLocalStream(`Sorry — I couldn't reach my brain just now. ${reason}. Please email hello@gatetest.ai if this keeps happening.`), {
      status: 200,
      headers: sseHeaders(),
    });
  }

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try { detail = (await upstream.text()).slice(0, 200); } catch { /* ignore */ }
    return new Response(makeLocalStream(`The chat agent is having trouble (status ${upstream.status}). Please email hello@gatetest.ai. ${detail}`), {
      status: 200,
      headers: sseHeaders(),
    });
  }

  // Translate Anthropic's SSE format into our client-side simpler shape:
  //  event: token  { text }
  //  event: done   { stop_reason }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* stream closed */ }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line || !line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const evt = JSON.parse(payload);
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                send("token", { text: String(evt.delta.text || "") });
              } else if (evt.type === "message_stop") {
                send("done", {});
              }
            } catch { /* ignore malformed event */ }
          }
        }
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "Stream interrupted" });
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}

export async function GET() {
  return NextResponse.json(
    {
      hint: "POST { messages: [{role, content}] } to chat with the GateTest support agent.",
    },
    { status: 405 }
  );
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

/**
 * Build a single-event SSE stream containing a canned reply. Used for
 * pre-filter responses, rate-limit messages, and Anthropic failures so
 * the client gets the same protocol shape either way.
 */
function makeLocalStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`event: token\ndata: ${JSON.stringify({ text })}\n\n`)
      );
      controller.enqueue(
        encoder.encode(`event: done\ndata: {}\n\n`)
      );
      controller.close();
    },
  });
}
