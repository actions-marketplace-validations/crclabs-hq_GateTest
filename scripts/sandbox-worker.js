/**
 * Sandbox worker — replaces Vercel cron in self-hosted deployments.
 *
 * Fires three tick routes on their configured schedules:
 *   /api/scan/worker/tick    every 2 minutes  (process queued scans)
 *   /api/watches/tick        every 5 minutes  (continuous watch scans)
 *   /api/admin/learning/cron every Monday 06:00  (confidence scorer refresh)
 *
 * The worker authenticates using CRON_SECRET (same secret Vercel would send).
 * If CRON_SECRET is unset it uses the admin password as a fallback.
 */

'use strict';

const BASE_URL = process.env.GATETEST_BASE_URL || 'http://localhost:3000';
const CRON_SECRET = process.env.CRON_SECRET || process.env.GATETEST_ADMIN_PASSWORD || '';

let lastLearningRun = null;

async function tick(path) {
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vercel-cron-secret': CRON_SECRET,
        'Authorization': `Bearer ${CRON_SECRET}`,
      },
    });
    const body = await res.json().catch(() => ({}));
    const status = body.ok === false ? 'NOOP' : (body.claimed ? 'CLAIMED' : 'OK');
    process.stdout.write(`[worker] ${path} → ${res.status} ${status}\n`);
    return body;
  } catch (err) {
    process.stderr.write(`[worker] ${path} → ERROR: ${err.message}\n`);
    return null;
  }
}

function shouldRunLearning() {
  const now = new Date();
  // Monday (1), 06:00 UTC
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 6) return false;
  if (!lastLearningRun) return true;
  // Only once per hour window
  return (Date.now() - lastLearningRun) > 60 * 60 * 1000;
}

async function loop() {
  let scanTick = 0;
  let watchTick = 0;

  process.stdout.write(`[worker] started — base: ${BASE_URL}\n`);

  // Wait for app to be ready
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) ready = true;
    } catch (err) {
      process.stderr.write(`[worker] health check attempt ${i + 1}: ${err.message}\n`);
    }
    if (!ready) await new Promise(r => setTimeout(r, 2000));
  }
  if (!ready) {
    process.stderr.write(`[worker] app never became healthy — exiting\n`);
    process.exit(1);
  }
  process.stdout.write(`[worker] app healthy — beginning tick loop\n`);

  // Every 30 seconds check if any scheduled tick is due
  const interval = setInterval(async () => {
    scanTick++;
    watchTick++;

    // Scan worker: every 2 minutes (4 × 30s)
    if (scanTick >= 4) {
      scanTick = 0;
      await tick('/api/scan/worker/tick');
    }

    // Watches: every 5 minutes (10 × 30s)
    if (watchTick >= 10) {
      watchTick = 0;
      await tick('/api/watches/tick');
    }

    // Learning cron: Monday 06:00 UTC
    if (shouldRunLearning()) {
      lastLearningRun = Date.now();
      await tick('/api/admin/learning/cron');
    }
  }, 30_000);

  // Keep interval reference alive (prevents resource-leak warning)
  process.on('SIGTERM', () => { clearInterval(interval); process.exit(0); });
  process.on('SIGINT',  () => { clearInterval(interval); process.exit(0); });
}

loop().catch(err => {
  process.stderr.write(`[worker] fatal: ${err.message}\n`);
  process.exit(1);
});
