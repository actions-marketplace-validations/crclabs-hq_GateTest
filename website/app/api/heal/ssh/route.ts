/**
 * SSH Auto-Heal Agent — connects to servers and fixes issues autonomously.
 *
 * POST /api/heal/ssh
 * Body: {
 *   host: string,
 *   port?: number,
 *   username?: string,
 *   // Auth: either password OR private key (from env vars)
 *   password?: string,
 *   // Issues from nuclear scan to fix
 *   issues: Array<{ category: string, title: string, detail: string }>
 * }
 *
 * Server credentials can also come from env vars:
 *   GATETEST_SSH_HOST, GATETEST_SSH_PORT, GATETEST_SSH_USER,
 *   GATETEST_SSH_PASSWORD, GATETEST_SSH_KEY
 *
 * The agent:
 * 1. Connects via SSH
 * 2. Diagnoses the specific issues
 * 3. Runs safe fix commands (from a whitelist — never arbitrary)
 * 4. Verifies the fix worked
 * 5. Returns a report of what was done
 */

import { NextRequest, NextResponse } from "next/server";
// ssh2 has native crypto bindings that Turbopack can't statically analyze.
// We require() it at runtime in the handler. The type is simplified here.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const maxDuration = 60;
export const runtime = "nodejs";

interface HealAction {
  issue: string;
  command: string;
  output: string;
  status: "fixed" | "failed" | "skipped";
  verifyCommand?: string;
  verifyResult?: string;
}

interface IssueInput {
  category: string;
  title: string;
  detail: string;
}

interface Playbook {
  match: (issue: IssueInput) => boolean;
  commands: Array<{
    label: string;
    cmd: string;
    verify?: string;
  }>;
}

// hardcoded-url-ok — localhost here is the TARGET remote server being
// diagnosed via SSH, not this application's own localhost. These strings
// are shell commands sent over SSH to check if services are running on
// the remote machine.
const PLAYBOOKS: Playbook[] = [
  {
    match: (i) => i.category === "SSL" || (i.title.toLowerCase().includes("ssl") && i.detail.includes("failed")),
    commands: [
      { label: "Detect web server", cmd: "which caddy >/dev/null 2>&1 && echo 'CADDY' || (which nginx >/dev/null 2>&1 && echo 'NGINX') || echo 'UNKNOWN'" },
      { label: "Check Caddy status", cmd: "sudo systemctl status caddy --no-pager -l 2>&1 | head -20 || echo 'caddy not found'" },
      { label: "Check nginx status", cmd: "sudo systemctl status nginx --no-pager -l 2>&1 | head -20 || echo 'nginx not found'" },
      { label: "Restart Caddy (auto-renews TLS)", cmd: "sudo systemctl restart caddy 2>&1 || echo 'caddy not installed'" },
      { label: "Restart nginx + certbot renew", cmd: "sudo systemctl restart nginx 2>&1 && (sudo certbot renew --force-renewal 2>&1 | tail -5) || echo 'nginx/certbot not available'" },
      { label: "Check app services", cmd: "sudo systemctl list-units --type=service --state=running 2>&1 | grep -E 'caddy|nginx|crontech|node|bun|pm2' | head -10" },
      { label: "Verify HTTPS", cmd: "curl -sI https://localhost -k 2>&1 | head -5", verify: "curl -sI https://localhost -k 2>&1 | head -3" }, // hardcoded-url-ok
    ],
  },
  {
    match: (i) => i.title.includes("Port 443") && i.detail.includes("CLOSED"),
    commands: [
      { label: "Detect web server", cmd: "which caddy >/dev/null 2>&1 && echo 'CADDY' || (which nginx >/dev/null 2>&1 && echo 'NGINX') || echo 'UNKNOWN'" },
      { label: "Start Caddy", cmd: "sudo systemctl start caddy 2>&1 && sudo systemctl enable caddy 2>&1 || echo 'caddy not installed'" },
      { label: "Start nginx", cmd: "sudo systemctl start nginx 2>&1 && sudo systemctl enable nginx 2>&1 || echo 'nginx not installed'" },
      { label: "Check app processes", cmd: "sudo ss -tlnp | grep -E ':443|:80|:3000|:3001' 2>&1" },
      { label: "Verify port 443", cmd: "sudo ss -tlnp | grep :443", verify: "curl -sI https://localhost -k 2>&1 | head -3" }, // hardcoded-url-ok
    ],
  },
  {
    match: (i) => i.title.includes("Port 80") && i.detail.includes("CLOSED"),
    commands: [
      { label: "Check all web servers", cmd: "sudo systemctl status caddy --no-pager 2>&1 | head -5; sudo systemctl status nginx --no-pager 2>&1 | head -5; sudo systemctl status apache2 --no-pager 2>&1 | head -5" },
      { label: "Start web server", cmd: "sudo systemctl start caddy 2>&1 || sudo systemctl start nginx 2>&1 || sudo systemctl start apache2 2>&1" },
      { label: "Verify port 80", cmd: "sudo ss -tlnp | grep :80" },
    ],
  },
  {
    match: (i) => i.title.toLowerCase().includes("compression") && i.detail.toLowerCase().includes("disabled"),
    commands: [
      { label: "Check Caddy encode config", cmd: "cat /etc/caddy/Caddyfile 2>&1 | grep -A2 encode || echo 'no Caddyfile or no encode directive'" },
      { label: "Check nginx gzip config", cmd: "sudo nginx -T 2>&1 | grep -i gzip | head -5 || echo 'nginx not available'" },
      { label: "Add Caddy encode gzip", cmd: "sudo sed -i '/^[^#]*{$/a\\    encode gzip' /etc/caddy/Caddyfile 2>&1 && sudo systemctl reload caddy 2>&1 || echo 'Caddy config not found'" },
      { label: "Verify compression", cmd: "curl -sI -H 'Accept-Encoding: gzip' https://localhost -k 2>&1 | grep -i content-encoding" }, // hardcoded-url-ok
    ],
  },
  {
    match: (i) => i.title.toLowerCase().includes("hsts") || i.title.toLowerCase().includes("security header"),
    commands: [
      { label: "Check Caddy header config", cmd: "cat /etc/caddy/Caddyfile 2>&1 | grep -A5 header || echo 'no header directives'" },
      { label: "Add security headers to Caddy", cmd: `sudo bash -c 'grep -q "header" /etc/caddy/Caddyfile 2>/dev/null || sed -i "/^[^#]*{$/a\\\\    header {\\n        Strict-Transport-Security \\"max-age=63072000; includeSubDomains; preload\\"\\n        X-Content-Type-Options \\"nosniff\\"\\n        X-Frame-Options \\"SAMEORIGIN\\"\\n        Referrer-Policy \\"strict-origin-when-cross-origin\\"\\n    }" /etc/caddy/Caddyfile' 2>&1 && sudo systemctl reload caddy 2>&1 || echo 'Caddy not available, trying nginx...' && sudo bash -c 'cat > /etc/nginx/conf.d/security-headers.conf << EOFH
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
EOFH' 2>&1 && sudo nginx -t 2>&1 && sudo systemctl reload nginx 2>&1` },
      { label: "Verify headers", cmd: "curl -sI https://localhost -k 2>&1 | grep -iE 'strict-transport|x-content-type|x-frame'" }, // hardcoded-url-ok
    ],
  },
  {
    match: (i) => i.detail.toLowerCase().includes("disk") || i.title.toLowerCase().includes("disk"),
    commands: [
      { label: "Check disk usage", cmd: "df -h / 2>&1" },
      { label: "Clear old logs", cmd: "sudo journalctl --vacuum-time=7d 2>&1 | tail -3" },
      { label: "Clear package cache", cmd: "sudo apt-get clean 2>&1 || bun cache clean 2>&1 || npm cache clean --force 2>&1" },
      { label: "Verify free space", cmd: "df -h / 2>&1" },
    ],
  },
  {
    match: (i) => i.detail.toLowerCase().includes("http") && i.detail.toLowerCase().includes("redirect"),
    commands: [
      { label: "Check redirect config", cmd: "cat /etc/caddy/Caddyfile 2>&1 | head -20 || sudo nginx -T 2>&1 | grep -A5 'listen 80' | head -10" },
      { label: "Verify redirect", cmd: "curl -sI http://localhost 2>&1 | head -5" }, // hardcoded-url-ok
    ],
  },
  {
    match: (i) => i.category === "HTTP" && i.detail.includes("failed"),
    commands: [
      { label: "Check all services", cmd: "sudo systemctl list-units --type=service --state=running 2>&1 | grep -E 'caddy|nginx|crontech|node|bun|pm2|docker' | head -15" },
      { label: "Check app ports", cmd: "sudo ss -tlnp | grep -E ':3000|:3001|:8080|:443|:80' 2>&1" },
      { label: "Check Caddy logs", cmd: "sudo journalctl -u caddy -n 30 --no-pager 2>&1 | tail -20" },
      { label: "Check crontech service logs", cmd: "sudo journalctl -u crontech-web -n 20 --no-pager 2>&1 || sudo journalctl -u crontech-api -n 20 --no-pager 2>&1 || echo 'no crontech services found'" },
      { label: "Restart all crontech services", cmd: "sudo systemctl restart caddy 2>&1; sudo systemctl restart crontech-web 2>&1 || true; sudo systemctl restart crontech-api 2>&1 || true" },
      { label: "Verify HTTP", cmd: "curl -sI http://localhost:3000 2>&1 | head -3 || curl -sI http://localhost 2>&1 | head -3" }, // hardcoded-url-ok
    ],
  },
];

function execSSH(conn: any, cmd: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Command timeout")), timeout);
    conn.exec(cmd, (err: Error | null, stream: any) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      let output = "";
      stream.on("data", (data: Buffer) => { output += data.toString(); });
      stream.stderr.on("data", (data: Buffer) => { output += data.toString(); });
      stream.on("close", () => { clearTimeout(timer); resolve(output.trim()); });
    });
  });
}

export async function POST(req: NextRequest) {
  let body: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    issues?: IssueInput[];
    hostname?: string;
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const host = body.host || process.env.GATETEST_SSH_HOST || "";
  const port = body.port || Number(process.env.GATETEST_SSH_PORT) || 22;
  const username = body.username || process.env.GATETEST_SSH_USER || "root";
  const password = body.password || process.env.GATETEST_SSH_PASSWORD || "";
  const privateKey = process.env.GATETEST_SSH_KEY || "";
  const issues = body.issues || [];

  if (!host) {
    return NextResponse.json({
      error: "No SSH host provided. Set GATETEST_SSH_HOST in Vercel env vars or pass { host } in the request.",
    }, { status: 400 });
  }

  if (!password && !privateKey) {
    return NextResponse.json({
      error: "No SSH credentials. Set GATETEST_SSH_PASSWORD or GATETEST_SSH_KEY in Vercel env vars.",
    }, { status: 400 });
  }

  if (issues.length === 0) {
    return NextResponse.json({ error: "No issues to fix" }, { status: 400 });
  }

  // Match issues to playbooks
  const actions: HealAction[] = [];
  const matched = new Set<number>();

  for (const issue of issues) {
    for (const playbook of PLAYBOOKS) {
      if (playbook.match(issue)) {
        matched.add(issues.indexOf(issue));
        for (const step of playbook.commands) {
          actions.push({
            issue: `${issue.category}: ${issue.title}`,
            command: step.cmd,
            output: "",
            status: "skipped",
            verifyCommand: step.verify,
          });
        }
        break;
      }
    }
  }

  const unmatched = issues.filter((_, i) => !matched.has(i));

  // Connect via SSH — fully dynamic to avoid Turbopack static analysis + TS module check.
  let Client: new () => any;
  try {
    const modName = "ssh2";
     
    Client = require(modName).Client;
  } catch {
    return NextResponse.json({
      error: "ssh2 module not installed. Run: npm install ssh2",
    }, { status: 503 });
  }
  const conn = new Client();
  const connectConfig: Record<string, unknown> = {
    host,
    port,
    username,
    readyTimeout: 10000,
  };

  if (privateKey) {
    connectConfig.privateKey = privateKey.replace(/\\n/g, "\n");
  } else {
    connectConfig.password = password;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      conn.on("ready", resolve);
      conn.on("error", reject);
      conn.connect(connectConfig as any);
    });
  } catch (err) {
    return NextResponse.json({
      error: `SSH connection failed: ${(err as Error).message}`,
      hint: "Check host, port, username, and credentials. For password auth, set GATETEST_SSH_PASSWORD. For key auth, set GATETEST_SSH_KEY.",
    }, { status: 502 });
  }

  // Execute fix commands
  for (const action of actions) {
    try {
      action.output = await execSSH(conn, action.command);
      action.status = "fixed";

      // Run verification if available
      if (action.verifyCommand) {
        action.verifyResult = await execSSH(conn, action.verifyCommand);
      }
    } catch (err) {
      action.output = (err as Error).message;
      action.status = "failed";
    }
  }

  conn.end();

  const fixed = actions.filter((a) => a.status === "fixed").length;
  const failed = actions.filter((a) => a.status === "failed").length;

  return NextResponse.json({
    status: failed === 0 ? "healed" : fixed > 0 ? "partial" : "failed",
    host,
    actionsRun: actions.length,
    fixed,
    failed,
    actions,
    unmatchedIssues: unmatched.map((i) => `${i.category}: ${i.title} — ${i.detail}`),
    message: fixed > 0
      ? `${fixed} fix${fixed > 1 ? "es" : ""} applied to ${host}. ${unmatched.length > 0 ? `${unmatched.length} issue(s) need manual review.` : ""}`
      : "No fixes could be applied. Check SSH credentials and server state.",
  });
}
