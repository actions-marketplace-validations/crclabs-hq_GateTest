/**
 * GET  /api/fixes       — list public fixes (paginated)
 * POST /api/fixes       — record a new fix (internal, requires admin auth or scan token)
 * DELETE /api/fixes     — opt-out a repo from the public registry
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db';
import {
  recordFix,
  listPublicFixes,
  countPublicFixes,
  getFixStats,
  optOutRepo,
  PAGE_SIZE,
} from '@/app/lib/fix-registry-store';
import { isAdminRequest } from '@/app/lib/admin-auth';

// ─── GET /api/fixes ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(PAGE_SIZE, parseInt(searchParams.get('pageSize') ?? String(PAGE_SIZE), 10) || PAGE_SIZE);
  const statsOnly = searchParams.get('stats') === '1';

  const sql = getDb();
  try {
    if (statsOnly) {
      const stats = await getFixStats(sql);
      return NextResponse.json({ ok: true, stats });
    }

    const [fixes, total] = await Promise.all([
      listPublicFixes(sql, { page, pageSize }),
      countPublicFixes(sql),
    ]);

    return NextResponse.json({
      ok: true,
      fixes,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch fixes';
    console.error('[api/fixes GET]', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── POST /api/fixes ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth: admin cookie OR Authorization: Bearer <GATETEST_SCAN_TOKEN>
  const isAdmin = isAdminRequest(req);
  const bearerToken = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const scanToken = process.env.GATETEST_SCAN_TOKEN;
  const hasValidToken = scanToken && bearerToken === scanToken;

  if (!isAdmin && !hasValidToken) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    repoName,
    prUrl,
    tier = 'full',
    errorsFixed = 0,
    warningsFixed = 0,
    modulesFired = [],
    message = null,
  } = body as {
    repoName?: string;
    prUrl?: string;
    tier?: string;
    errorsFixed?: number;
    warningsFixed?: number;
    modulesFired?: string[];
    message?: string | null;
  };

  const sql = getDb();
  try {
    const row = await recordFix(sql, {
      repoName: String(repoName ?? ''),
      prUrl: String(prUrl ?? ''),
      tier: String(tier),
      errorsFixed: Number(errorsFixed) || 0,
      warningsFixed: Number(warningsFixed) || 0,
      modulesFired: Array.isArray(modulesFired) ? modulesFired : [],
      message: message ? String(message) : null,
    });
    return NextResponse.json({ ok: true, id: row?.id?.toString() ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to record fix';
    console.error('[api/fixes POST]', msg);
    const status = msg.includes('required') ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}

// ─── DELETE /api/fixes ────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const isAdmin = isAdminRequest(req);
  if (!isAdmin) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { repoName } = body as { repoName?: string };
  if (!repoName) {
    return NextResponse.json({ ok: false, error: 'repoName is required' }, { status: 400 });
  }

  const sql = getDb();
  try {
    await optOutRepo(sql, String(repoName));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to opt out';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
