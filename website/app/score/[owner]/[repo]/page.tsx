/**
 * GateTest Score — public quality score page.
 * /score/:owner/:repo
 *
 * Shows the public GateTest score for any scanned repository.
 * Embeddable badge available at /api/score?owner=X&repo=Y&format=badge
 */
import Link from "next/link";
export const dynamic = "force-dynamic";

interface ScoreData {
  owner: string;
  repo: string;
  score: number | null;
  grade: string | null;
  label: string | null;
  color: string | null;
  lastScan?: {
    tier: string;
    scannedAt: string;
    ageDays: number;
    errors: number;
    warnings: number;
  };
  badge?: string;
  readme?: string;
  message?: string;
}

async function fetchScore(owner: string, repo: string): Promise<ScoreData> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "https://gatetest.ai";
  try {
    const res = await fetch(`${base}/api/score?owner=${owner}&repo=${repo}`, { cache: "no-store" });
    return res.json();
  } catch {
    return { owner, repo, score: null, grade: null, label: null, color: null, message: "Could not load score" };
  }
}

function GradeRing({ score, grade, color }: { score: number; grade: string; color: string }) {
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="relative flex items-center justify-center w-40 h-40">
      <svg className="w-40 h-40 -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
        <circle
          cx="60" cy="60" r={r} fill="none"
          stroke={color} strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-4xl font-black text-white">{grade}</div>
        <div className="text-lg font-bold" style={{ color }}>{score}/100</div>
      </div>
    </div>
  );
}

export default async function ScorePage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const data = await fetchScore(owner, repo);

  const hasScore = data.score !== null;
  const tierLabel: Record<string, string> = {
    quick: "Quick Scan ($29)",
    full: "Full Scan ($99)",
    scan_fix: "Scan + Fix ($199)",
    nuclear: "Nuclear ($399)",
  };

  return (
    <main className="min-h-screen bg-black text-white">
      {/* Header */}
      <div className="border-b border-white/8 px-6 py-4 flex items-center justify-between max-w-5xl mx-auto">
        <Link href="/" className="flex items-center gap-2 text-white/60 hover:text-white transition-colors text-sm">
          <span className="text-lg">←</span> gatetest.ai
        </Link>
        <span className="text-xs text-white/30 font-mono">public quality score</span>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-16">
        {/* Repo title */}
        <div className="mb-12 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">
            <span className="text-white/40">{owner}</span>
            <span className="text-white/20 mx-2">/</span>
            <span>{repo}</span>
          </h1>
          <p className="text-white/40 text-sm">GateTest quality score · powered by Claude Opus 4.7</p>
        </div>

        {hasScore ? (
          <>
            {/* Score card */}
            <div className="flex flex-col sm:flex-row items-center gap-10 p-8 rounded-2xl border border-white/10 bg-white/[0.02] mb-8">
              <GradeRing
                score={data.score!}
                grade={data.grade!}
                color={data.color!}
              />
              <div className="flex-1 text-center sm:text-left">
                <div className="text-2xl font-bold text-white mb-1">{data.label}</div>
                <div className="text-white/50 mb-4">
                  {data.lastScan?.errors} errors · {data.lastScan?.warnings} warnings ·{" "}
                  {data.lastScan?.tier ? tierLabel[data.lastScan.tier] || data.lastScan.tier : ""}
                </div>
                <div className="flex flex-wrap gap-3">
                  <a
                    href={`https://gatetest.ai?repo=${encodeURIComponent(`${owner}/${repo}`)}`}
                    className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-sm font-semibold transition-colors"
                  >
                    Improve this score →
                  </a>
                  {data.lastScan && (
                    <span className="px-4 py-2 text-white/30 text-sm">
                      Last scanned {data.lastScan.ageDays === 0 ? "today" : `${data.lastScan.ageDays}d ago`}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Badge + README embed */}
            <div className="grid sm:grid-cols-2 gap-4 mb-8">
              <div className="p-5 rounded-xl border border-white/8 bg-white/[0.02]">
                <div className="text-xs text-white/40 font-semibold uppercase tracking-wider mb-3">Badge preview</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={data.badge}
                  alt="GateTest score badge"
                  width={120}
                  height={20}
                  className="mb-3"
                />
              </div>
              <div className="p-5 rounded-xl border border-white/8 bg-white/[0.02]">
                <div className="text-xs text-white/40 font-semibold uppercase tracking-wider mb-3">Add to README</div>
                <pre className="text-xs text-white/60 font-mono bg-black/40 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
                  {data.readme}
                </pre>
              </div>
            </div>

            {/* Score breakdown */}
            <div className="p-6 rounded-xl border border-white/8 bg-white/[0.02]">
              <div className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-4">How the score is calculated</div>
              <div className="grid sm:grid-cols-3 gap-4 text-sm">
                {[
                  { label: "Start", value: "100", note: "base score" },
                  { label: "Errors", value: `−${Math.min(50, (data.lastScan?.errors || 0) * 5)}`, note: `−5 each (max −50)` },
                  { label: "Warnings", value: `−${Math.min(20, (data.lastScan?.warnings || 0) * 1)}`, note: `−1 each (max −20)` },
                  { label: "Fix tier bonus", value: ["scan_fix", "nuclear"].includes(data.lastScan?.tier || "") ? "+5" : "+0", note: "scan_fix / nuclear" },
                  { label: "Staleness", value: (data.lastScan?.ageDays || 0) > 7 ? `−${Math.floor(((data.lastScan?.ageDays || 0) - 7) / 7) * 5}` : "−0", note: `−5/week after 7d` },
                  { label: "Final score", value: String(data.score), note: data.label || "" },
                ].map((r) => (
                  <div key={r.label} className="text-center p-3 rounded-lg bg-white/5">
                    <div className="text-lg font-bold text-white">{r.value}</div>
                    <div className="text-white/60 text-xs">{r.label}</div>
                    <div className="text-white/25 text-xs mt-0.5">{r.note}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          /* No scan yet */
          <div className="text-center py-16">
            <div className="text-6xl font-black text-white/10 mb-4">?</div>
            <h2 className="text-2xl font-bold text-white mb-2">No scans found</h2>
            <p className="text-white/50 mb-8">
              {owner}/{repo} hasn&apos;t been scanned yet. Run a GateTest scan to get a public score.
            </p>
            <a
              href={`https://gatetest.ai#pricing`}
              className="inline-block px-8 py-3 rounded-xl bg-white/10 hover:bg-white/15 text-white font-semibold transition-colors"
            >
              Scan this repo →
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
