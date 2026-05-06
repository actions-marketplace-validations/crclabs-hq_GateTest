/**
 * /fixes — Public "Fixed by GateTest" registry.
 *
 * Every PR that GateTest ships is logged here as social proof.
 * Server component — fetches data from /api/fixes at render time.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Fixed by GateTest — Public Fix Registry',
  description: 'Every bug, vulnerability, and code issue fixed by GateTest — public proof from real repos.',
};

// Always dynamically rendered — live data, no static prerender
export const dynamic = 'force-dynamic';
export const revalidate = 60;

interface Fix {
  id: string;
  created_at: string;
  repo_name: string;
  pr_url: string;
  tier: string;
  errors_fixed: number;
  warnings_fixed: number;
  modules_fired: string[];
  message: string | null;
}

interface Stats {
  total_fixes: number;
  total_errors_fixed: number;
  total_warnings_fixed: number;
  unique_repos: number;
}

async function fetchFixes(page = 1): Promise<{ fixes: Fix[]; pagination: Record<string, number> }> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/fixes?page=${page}`, { next: { revalidate: 60 } });
  if (!res.ok) return { fixes: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } };
  const data = await res.json();
  return data.ok ? data : { fixes: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } };
}

async function fetchStats(): Promise<Stats> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/fixes?stats=1`, { next: { revalidate: 60 } });
  if (!res.ok) return { total_fixes: 0, total_errors_fixed: 0, total_warnings_fixed: 0, unique_repos: 0 };
  const data = await res.json();
  return data.ok ? data.stats : { total_fixes: 0, total_errors_fixed: 0, total_warnings_fixed: 0, unique_repos: 0 };
}

const TIER_LABELS: Record<string, { label: string; color: string }> = {
  quick: { label: 'Quick', color: 'text-slate-400 bg-slate-400/10' },
  full: { label: 'Full', color: 'text-blue-400 bg-blue-400/10' },
  'scan_fix': { label: 'Scan+Fix', color: 'text-violet-400 bg-violet-400/10' },
  nuclear: { label: 'Nuclear', color: 'text-rose-400 bg-rose-400/10' },
};

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function repoShortName(repoName: string) {
  const parts = repoName.split('/');
  return parts[parts.length - 1] || repoName;
}

export default async function FixesPage() {
  const [{ fixes, pagination }, stats] = await Promise.all([fetchFixes(), fetchStats()]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        {/* Header */}
        <div className="mb-12 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-400 text-xs font-medium mb-4">
            🔧 Public Registry
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            Fixed by GateTest
          </h1>
          <p className="text-lg text-slate-400 max-w-xl mx-auto">
            Real bugs, vulnerabilities, and code issues fixed by GateTest across real repos.
            Every entry is a delivered PR.
          </p>
        </div>

        {/* Stats banner */}
        {stats.total_fixes > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-12">
            {[
              { label: 'PRs shipped', value: stats.total_fixes.toLocaleString() },
              { label: 'Errors fixed', value: stats.total_errors_fixed.toLocaleString() },
              { label: 'Warnings fixed', value: stats.total_warnings_fixed.toLocaleString() },
              { label: 'Unique repos', value: stats.unique_repos.toLocaleString() },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 text-center">
                <div className="text-2xl font-bold text-teal-400">{value}</div>
                <div className="text-xs text-slate-500 mt-1">{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Fix list */}
        {fixes.length === 0 ? (
          <div className="text-center py-24 text-slate-500">
            <div className="text-4xl mb-4">🔧</div>
            <p>No fixes recorded yet.</p>
            <p className="text-sm mt-2">Every GateTest-delivered PR will appear here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {fixes.map((fix) => {
              const tier = TIER_LABELS[fix.tier] ?? { label: fix.tier, color: 'text-slate-400 bg-slate-400/10' };
              const modules = (fix.modules_fired ?? []).slice(0, 4);
              const moreModules = (fix.modules_fired ?? []).length - modules.length;

              return (
                <div
                  key={fix.id}
                  className="rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-teal-500/20 transition-colors p-5"
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-slate-400 font-mono text-sm truncate max-w-[180px]" title={fix.repo_name}>
                        {repoShortName(fix.repo_name)}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tier.color}`}>
                        {tier.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500 shrink-0">
                      <span>{formatDate(fix.created_at)}</span>
                      <a
                        href={fix.pr_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-teal-400 hover:text-teal-300 transition-colors"
                        aria-label={`View PR for ${fix.repo_name}`}
                      >
                        View PR →
                      </a>
                    </div>
                  </div>

                  {fix.message && (
                    <p className="text-sm text-slate-300 mt-2 line-clamp-2">{fix.message}</p>
                  )}

                  <div className="flex items-center gap-4 mt-3 text-xs text-slate-500">
                    {fix.errors_fixed > 0 && (
                      <span className="text-rose-400">🔴 {fix.errors_fixed} error{fix.errors_fixed !== 1 ? 's' : ''} fixed</span>
                    )}
                    {fix.warnings_fixed > 0 && (
                      <span className="text-amber-400">🟡 {fix.warnings_fixed} warning{fix.warnings_fixed !== 1 ? 's' : ''} fixed</span>
                    )}
                    {modules.length > 0 && (
                      <div className="flex items-center gap-1 flex-wrap">
                        {modules.map((m) => (
                          <span key={m} className="px-1.5 py-0.5 rounded bg-white/[0.04] text-slate-400">
                            {m}
                          </span>
                        ))}
                        {moreModules > 0 && (
                          <span className="text-slate-500">+{moreModules} more</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="flex justify-center gap-4 mt-8">
            {pagination.page > 1 && (
              <Link
                href={`/fixes?page=${pagination.page - 1}`}
                className="px-4 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] text-sm text-slate-300 transition-colors"
              >
                ← Previous
              </Link>
            )}
            <span className="px-4 py-2 text-sm text-slate-500">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            {pagination.page < pagination.totalPages && (
              <Link
                href={`/fixes?page=${pagination.page + 1}`}
                className="px-4 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] text-sm text-slate-300 transition-colors"
              >
                Next →
              </Link>
            )}
          </div>
        )}

        {/* CTA */}
        <div className="mt-16 rounded-xl bg-teal-500/5 border border-teal-500/15 p-8 text-center">
          <h2 className="text-xl font-semibold mb-2">Want your repo in this list?</h2>
          <p className="text-slate-400 text-sm mb-6">
            GateTest scans your code, fixes the issues, and opens a PR. You merge. Done.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 bg-teal-500 hover:bg-teal-400 text-black font-semibold rounded-lg transition-colors"
          >
            Scan your repo →
          </Link>
        </div>
      </div>
    </div>
  );
}
