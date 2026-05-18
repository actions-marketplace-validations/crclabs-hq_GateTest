// Shared Sentry scrubber for gatetest.ai.
//
// PURPOSE: Sentry server/edge/client configs all set sendDefaultPii=true,
// includeLocalVariables=true (server), and enableLogs=true. Without an
// active beforeSend filter, an uncaught exception in /api/scan/fix would
// ship the customer's source code + prompt body + repo URL to Sentry as
// stack-frame locals. That is a data-flow we DO NOT have customer
// consent for, and Sentry is documented (or will be) as a sub-processor
// only for HTTP-metadata + scrubbed stack traces.
//
// CONTRACT: A safe Sentry event:
//   1. Never carries any local variable named in SENSITIVE_KEYS
//      (these are dropped, replaced by "[redacted: sensitive]")
//   2. Never carries an oversize string local (> MAX_STRING_BYTES)
//      (these are replaced by "[redacted: oversize XX KB]")
//   3. Never carries request body, cookies, or authorization headers
//      in the request payload OR in breadcrumbs
//
// USAGE: Import scrubEvent + scrubBreadcrumb and wire into Sentry.init
// via beforeSend / beforeSendTransaction / beforeBreadcrumb.

const SENSITIVE_KEYS = new Set([
  "body",
  "prompt",
  "fileContent",
  "filecontent",
  "file_content",
  "messages",
  "repoUrl",
  "repourl",
  "repo_url",
  "apiKey",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "authorization",
  "auth",
  "cookie",
  "cookies",
  "set-cookie",
  "x-api-key",
  "anthropic-api-key",
  "stripe-signature",
  "x-hub-signature-256",
  "x-gluecron-signature",
]);

const MAX_STRING_BYTES = 4 * 1024; // 4 KB ceiling per local

// Portable UTF-8 byte length — works in browser AND Node. Prefer
// TextEncoder (modern, fast) when available; fall back to Node's
// Buffer; final fallback is a manual count for very old hosts.
function utf8ByteLength(str) {
  if (typeof str !== "string") return 0;
  if (typeof TextEncoder !== "undefined") {
    try {
      return new TextEncoder().encode(str).length;
    } catch (_) {
      // fall through
    }
  }
  if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(str, "utf8");
  }
  // Manual fallback (rare): count UTF-8 bytes per code point.
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++; // surrogate pair
    } else bytes += 3;
  }
  return bytes;
}

function isSensitiveKey(key) {
  if (typeof key !== "string") return false;
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function redactedSensitive() {
  return "[redacted: sensitive]";
}

function redactedOversize(byteLen) {
  const kb = Math.round(byteLen / 1024);
  return `[redacted: oversize ${kb} KB]`;
}

function scrubValue(key, value) {
  if (isSensitiveKey(key)) return redactedSensitive();
  if (typeof value === "string") {
    const byteLen = utf8ByteLength(value);
    if (byteLen > MAX_STRING_BYTES) return redactedOversize(byteLen);
    return value;
  }
  return value;
}

// Recursively scrub an object's string keys + values.
function scrubObject(obj, depth = 0) {
  if (depth > 6) return "[redacted: depth]"; // bound recursion
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => (typeof v === "object" ? scrubObject(v, depth + 1) : v));
  }
  if (typeof obj !== "object") return obj;

  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      out[key] = redactedSensitive();
      continue;
    }
    if (typeof value === "string") {
      const byteLen = utf8ByteLength(value);
      if (byteLen > MAX_STRING_BYTES) {
        out[key] = redactedOversize(byteLen);
        continue;
      }
      out[key] = value;
      continue;
    }
    if (typeof value === "object" && value !== null) {
      out[key] = scrubObject(value, depth + 1);
      continue;
    }
    out[key] = value;
  }
  return out;
}

// Scrub a Sentry stack-frame vars object. Removes sensitive keys and
// caps oversize strings.
function scrubFrameVars(vars) {
  if (!vars || typeof vars !== "object") return vars;
  const out = {};
  for (const [key, value] of Object.entries(vars)) {
    if (isSensitiveKey(key)) {
      out[key] = redactedSensitive();
      continue;
    }
    out[key] = scrubValue(key, value);
  }
  return out;
}

// Scrub request payload — strip body, cookies, sensitive headers.
function scrubRequest(request) {
  if (!request || typeof request !== "object") return request;
  const out = { ...request };
  if ("data" in out) out.data = redactedSensitive();
  if ("cookies" in out) out.cookies = redactedSensitive();
  if (out.headers && typeof out.headers === "object") {
    const headers = {};
    for (const [k, v] of Object.entries(out.headers)) {
      headers[k] = isSensitiveKey(k) ? redactedSensitive() : v;
    }
    out.headers = headers;
  }
  return out;
}

// Main entry point — pass to Sentry.init's beforeSend.
// Returns the mutated event, or null to drop entirely.
function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;

  // Scrub stack-frame locals on every exception frame.
  if (event.exception && Array.isArray(event.exception.values)) {
    for (const ex of event.exception.values) {
      if (ex.stacktrace && Array.isArray(ex.stacktrace.frames)) {
        for (const frame of ex.stacktrace.frames) {
          if (frame.vars) frame.vars = scrubFrameVars(frame.vars);
        }
      }
    }
  }

  // Strip request body / cookies / sensitive headers.
  if (event.request) event.request = scrubRequest(event.request);

  // Scrub extras + contexts (they're commonly used to attach
  // ad-hoc data, including bodies).
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) event.contexts = scrubObject(event.contexts);

  // Tags should be short string labels; cap them just in case.
  if (event.tags && typeof event.tags === "object") {
    const tags = {};
    for (const [k, v] of Object.entries(event.tags)) {
      tags[k] = isSensitiveKey(k) ? redactedSensitive() : scrubValue(k, v);
    }
    event.tags = tags;
  }

  // Breadcrumbs may carry HTTP data — scrub each.
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((bc) => scrubBreadcrumb(bc));
  }

  return event;
}

// Scrub a single breadcrumb. Used both inline and via beforeBreadcrumb.
function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
  const out = { ...breadcrumb };
  if (out.data && typeof out.data === "object") {
    out.data = scrubObject(out.data);
  }
  return out;
}

module.exports = {
  scrubEvent,
  scrubBreadcrumb,
  scrubFrameVars,
  scrubRequest,
  scrubObject,
  isSensitiveKey,
  utf8ByteLength,
  SENSITIVE_KEYS,
  MAX_STRING_BYTES,
};
