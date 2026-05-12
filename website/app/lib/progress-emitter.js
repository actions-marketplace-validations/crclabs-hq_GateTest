/**
 * SSE progress-event emitter — used by /api/scan/fix to stream per-file
 * progress to the customer in real time so they see fixes happen instead
 * of staring at a 4-minute spinner.
 *
 * Wire format: standard text/event-stream (`event: <name>\ndata: <json>\n\n`).
 * The browser side uses fetch + ReadableStream reader (NOT EventSource —
 * EventSource only supports GET, our route is POST with a JSON body).
 *
 * Two consumers built into one helper:
 *   1. createEmitter() — returns { emit, end, response } for the route to
 *      attach to a streaming Response.
 *   2. parseSseStream(reader, onEvent) — page-side loop that decodes the
 *      stream into typed events and calls back per event.
 *
 * Designed to be a no-op when `enabled: false` so the route can keep
 * the same code path for both streaming and non-streaming requests.
 */

'use strict';

/**
 * Construct a streaming-progress emitter. When `enabled` is true, returns
 * a working emitter + a Response with the stream body. When false, all
 * methods are no-ops and `response` is null — caller falls back to plain
 * JSON response.
 *
 * @param {{ enabled: boolean }} opts
 * @returns {{
 *   enabled: boolean,
 *   emit: (eventName: string, data: object) => void,
 *   end: (finalData?: object) => Promise<void>,
 *   response: Response | null,
 * }}
 */
function createEmitter({ enabled }) {
  if (!enabled) {
    return {
      enabled: false,
      emit: () => {},
      end: async () => {},
      response: null,
    };
  }

  const encoder = new TextEncoder();
  let writer = null;
  let closed = false;

  // The ReadableStream's start() callback receives a controller. We
  // capture it as `writer` so emit() can push chunks asynchronously
  // from outside the start() function. Chunks queue until a consumer
  // begins reading; once reading begins, they flush immediately.
  const stream = new ReadableStream({
    start(controller) {
      writer = controller;
    },
    cancel() {
      closed = true;
    },
  });

  function format(eventName, data) {
    const json = JSON.stringify(data ?? {});
    // Per spec: each event is `event: NAME\ndata: <line>\n\n`. Multi-line
    // JSON would need data: prefix per line, but stringify produces a
    // single line so this is safe.
    return `event: ${eventName}\ndata: ${json}\n\n`;
  }

  return {
    enabled: true,
    emit(eventName, data) {
      if (closed || !writer) return;
      try {
        writer.enqueue(encoder.encode(format(eventName, data)));
      } catch {
        closed = true;
      }
    },
    async end(finalData) {
      if (closed || !writer) return;
      try {
        if (finalData !== undefined) {
          writer.enqueue(encoder.encode(format('done', finalData)));
        }
        writer.close();
      } catch {
        // already closed
      } finally {
        closed = true;
      }
    },
    response: new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    }),
  };
}

/**
 * Parse an SSE byte stream into typed events. Browser-side helper.
 * Calls `onEvent({ name, data })` for each fully-received event. The
 * `data` field is JSON-parsed; if parsing fails the raw string is
 * passed through.
 *
 * @param {ReadableStreamDefaultReader} reader
 * @param {(event: { name: string, data: any }) => void} onEvent
 * @returns {Promise<void>} resolves when the stream closes.
 */
async function parseSseStream(reader, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line (\n\n). Parse complete
    // events out of the buffer; leave any partial event in place.
    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseEventBlock(block);
      if (parsed) onEvent(parsed);
      sep = buffer.indexOf('\n\n');
    }
  }
}

function parseEventBlock(block) {
  let name = 'message';
  let dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      name = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { name, data };
}

module.exports = { createEmitter, parseSseStream };
