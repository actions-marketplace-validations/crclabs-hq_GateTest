/**
 * /api/scan/fix/stream — SSE-wrapped front door for the fix loop.
 *
 * Why this exists: customers running a fix on the scan page were
 * staring at a 4-minute spinner with zero feedback. This endpoint
 * proxies to /api/scan/fix internally and emits heartbeats every
 * 5 seconds with elapsed time + a final `done` event carrying the
 * full FixResult JSON. The fix-loop logic itself is unchanged —
 * the wrapper exists so the browser has a live channel.
 *
 * Wire format: standard text/event-stream. Events:
 *   - event: started   data: { startedAt }
 *   - event: heartbeat data: { elapsedMs, elapsedHuman }
 *   - event: done      data: <FixResult JSON>
 *   - event: error     data: { message }
 *
 * Page-side helper: parseSseStream() in app/lib/progress-emitter.js.
 *
 * Backwards-compat: the existing /api/scan/fix continues to work
 * unchanged for any caller that prefers a single JSON response.
 */

import { NextRequest } from "next/server";
const { createEmitter } = require("@/app/lib/progress-emitter") as {
  createEmitter: (opts: { enabled: boolean }) => {
    enabled: boolean;
    emit: (eventName: string, data: object) => void;
    end: (finalData?: object) => Promise<void>;
    response: Response | null;
  };
};

// Match the inner endpoint's max duration so the wrapper doesn't
// time out before the work it's proxying.
export const maxDuration = 300;

const HEARTBEAT_MS = 5_000;

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export async function POST(req: NextRequest) {
  // Read the request body as raw text — we'll forward it verbatim
  // to the inner endpoint so any changes there don't drift.
  let body: string;
  try {
    body = await req.text();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate JSON shape minimally — we want to fail fast with a
  // proper status code rather than start a stream that errors out.
  try {
    JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Construct the inner URL — same host, /api/scan/fix.
  const innerUrl = new URL("/api/scan/fix", req.url).toString();

  const emitter = createEmitter({ enabled: true });
  const startedAt = Date.now();

  // Open the stream with a "started" frame so the UI can flip
  // immediately into in-flight state.
  emitter.emit("started", { startedAt });

  // Heartbeat loop — every HEARTBEAT_MS until the inner request
  // resolves. The browser uses these to update the progress UI and
  // confirm the connection is alive.
  let stopped = false;
  const heartbeatInterval = setInterval(() => {
    if (stopped) return;
    const elapsedMs = Date.now() - startedAt;
    emitter.emit("heartbeat", {
      elapsedMs,
      elapsedHuman: formatElapsed(elapsedMs),
    });
  }, HEARTBEAT_MS);

  // Run the inner fetch in the background. When it resolves,
  // emit the final `done` event with the full FixResult and close
  // the stream. The outer Response (emitter.response) returns
  // immediately with the streaming body.
  (async () => {
    try {
      const innerRes = await fetch(innerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Forward auth cookies / headers so the inner endpoint
          // sees the same caller identity.
          ...Object.fromEntries(req.headers.entries()),
        },
        body,
      });
      const innerJson = (await innerRes.json().catch(() => ({
        error: "Inner endpoint returned non-JSON response",
      }))) as Record<string, unknown>;
      stopped = true;
      clearInterval(heartbeatInterval);
      // Echo the inner status into the event so the UI can branch
      // on success vs error without re-parsing.
      const finalEvent = {
        ...innerJson,
        __innerStatus: innerRes.status,
        elapsedMs: Date.now() - startedAt,
      };
      await emitter.end(finalEvent);
    } catch (err) {
      stopped = true;
      clearInterval(heartbeatInterval);
      emitter.emit("error", {
        message: err instanceof Error ? err.message : "stream proxy failed",
      });
      await emitter.end({ error: err instanceof Error ? err.message : "stream proxy failed" });
    }
  })();

  // Return the streaming response immediately. The body keeps
  // flowing until end() above closes it.
  return emitter.response as Response;
}
