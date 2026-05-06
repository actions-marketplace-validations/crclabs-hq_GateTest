/**
 * POST /api/integrations/ai-generators
 *
 * Scan endpoint for AI code generators (v0, Lovable, Bolt.new, Replit Agent,
 * Cursor, Copilot Workspace, etc.).
 *
 * Unlike /api/scan/run (which clones a full repo), this endpoint accepts raw
 * code files inline and returns findings in under 10 seconds — fast enough
 * to embed in a generation workflow before the user sees the output.
 *
 * REQUEST (application/json):
 * {
 *   "generator": "v0" | "lovable" | "bolt" | "replit" | "cursor" | "other",
 *   "files": [
 *     { "path": "app/api/route.ts", "content": "..." },
 *     ...
 *   ],
 *   "suite": "quick" | "security" | "full"   // default: quick
 *   "apiKey": "<gatetest-api-key>"            // or Authorization: Bearer <key>
 * }
 *
 * RESPONSE:
 * {
 *   "ok": true,
 *   "generator": "v0",
 *   "filesScanned": 3,
 *   "duration_ms": 1234,
 *   "findings": [
 *     {
 *       "severity": "error" | "warning" | "info",
 *       "module": "secrets",
 *       "file": "app/api/route.ts",
 *       "line": 12,
 *       "message": "Hardcoded API key detected",
 *       "suggestion": "Move to environment variable"
 *     }
 *   ],
 *   "summary": {
 *     "errors": 1,
 *     "warnings": 4,
 *     "passed": true
 *   },
 *   "badge": "https://gatetest.ai/badge/pass" | "https://gatetest.ai/badge/fail"
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { runTier } from '@/app/lib/scan-modules';

const ALLOWED_GENERATORS = ['v0', 'lovable', 'bolt', 'replit', 'cursor', 'copilot', 'other'];
const ALLOWED_SUITES = ['quick', 'security', 'full'];
const MAX_FILES = 50;
const MAX_FILE_BYTES = 200 * 1024; // 200 KB per file
const MAX_TOTAL_BYTES = 2 * 1024 * 1024; // 2 MB total
const BADGE_BASE = process.env.NEXT_PUBLIC_BASE_URL || 'https://gatetest.ai';

interface IncomingFile {
  path: string;
  content: string;
}

interface FindingOut {
  severity: string;
  module: string;
  file: string;
  line: number | null;
  message: string;
  suggestion?: string;
}

function extractApiKey(req: NextRequest, body: Record<string, unknown>): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  if (typeof body.apiKey === 'string' && body.apiKey.length > 0) return body.apiKey;
  return null;
}

async function validateApiKey(key: string): Promise<boolean> {
  // Accept the admin password as a valid key for self-hosted / dev scenarios.
  // In production, extend this to look up keys in a dedicated api_keys table.
  const adminPw = process.env.GATETEST_ADMIN_PASSWORD;
  if (adminPw && key === adminPw) return true;
  // Prefix-based key format: "gt_<32+ hex chars>"
  return /^gt_[0-9a-f]{32,}$/i.test(key);
}

function normaliseFile(f: unknown): IncomingFile | null {
  if (!f || typeof f !== 'object') return null;
  const obj = f as Record<string, unknown>;
  if (typeof obj.path !== 'string' || typeof obj.content !== 'string') return null;
  if (obj.path.length === 0 || obj.content.length === 0) return null;
  return { path: obj.path, content: obj.content };
}

function extractFindings(modules: unknown[]): FindingOut[] {
  const out: FindingOut[] = [];
  for (const mod of modules) {
    if (!mod || typeof mod !== 'object') continue;
    const m = mod as Record<string, unknown>;
    const moduleName = typeof m.module === 'string' ? m.module : 'unknown';
    const checks = Array.isArray(m.checks) ? m.checks : [];
    for (const check of checks) {
      if (!check || typeof check !== 'object') continue;
      const c = check as Record<string, unknown>;
      if (c.passed) continue;
      out.push({
        severity: typeof c.severity === 'string' ? c.severity : 'warning',
        module: moduleName,
        file: typeof c.file === 'string' ? c.file : '',
        line: typeof c.line === 'number' ? c.line : null,
        message: typeof c.message === 'string' ? c.message : '',
        suggestion: typeof c.suggestion === 'string' ? c.suggestion : undefined,
      });
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  // Auth
  const apiKey = extractApiKey(req, body);
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'API key required. Pass Authorization: Bearer <key> or apiKey in body.' },
      { status: 401 },
    );
  }
  const authed = await validateApiKey(apiKey);
  if (!authed) {
    return NextResponse.json({ ok: false, error: 'Invalid API key' }, { status: 403 });
  }

  // Generator name (informational only — for logging/analytics)
  const generator = ALLOWED_GENERATORS.includes(String(body.generator))
    ? String(body.generator)
    : 'other';

  // Suite
  const rawSuite = String(body.suite || 'quick');
  const suite = ALLOWED_SUITES.includes(rawSuite) ? rawSuite : 'quick';

  // Files
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json({ ok: false, error: 'files[] array required' }, { status: 400 });
  }

  const rawFiles = body.files.slice(0, MAX_FILES);
  const files: IncomingFile[] = [];
  let totalBytes = 0;

  for (const f of rawFiles) {
    const norm = normaliseFile(f);
    if (!norm) continue;
    const bytes = Buffer.byteLength(norm.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) continue; // skip oversized individual files
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) break;
    files.push(norm);
  }

  if (files.length === 0) {
    return NextResponse.json({ ok: false, error: 'No valid files provided (check size limits)' }, { status: 400 });
  }

  // Build a synthetic file map for runTier
  const fileMap: Record<string, string> = {};
  for (const f of files) {
    fileMap[f.path] = f.content;
  }

  // Run scan
  let scanResult: unknown;
  try {
    scanResult = await runTier(suite as 'quick' | 'full', fileMap);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Scan failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const result = scanResult as Record<string, unknown>;
  const modules = Array.isArray(result.modules) ? result.modules : [];
  const findings = extractFindings(modules);

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const passed = errors === 0;
  const badge = `${BADGE_BASE}/badge/${passed ? 'pass' : 'fail'}`;

  return NextResponse.json({
    ok: true,
    generator,
    filesScanned: files.length,
    duration_ms: Date.now() - t0,
    findings,
    summary: { errors, warnings, passed },
    badge,
  });
}

// Lightweight GET — integration health check
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'POST /api/integrations/ai-generators',
    description: 'Scan code generated by AI tools (v0, Lovable, Bolt.new, Replit, Cursor) before delivery',
    docs: 'https://gatetest.ai/docs/integrations/ai-generators',
    maxFiles: MAX_FILES,
    maxFileSizeKb: MAX_FILE_BYTES / 1024,
    suites: ALLOWED_SUITES,
    generators: ALLOWED_GENERATORS,
  });
}
