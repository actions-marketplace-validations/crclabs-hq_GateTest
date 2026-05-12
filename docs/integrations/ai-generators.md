# GateTest × AI Code Generators

Scan AI-generated code before it reaches your users.

**Endpoint:** `POST https://gatetest.ai/api/integrations/ai-generators`

---

## Why

v0, Lovable, Bolt.new, Replit Agent, and Cursor generate working code fast — but they routinely ship hardcoded API keys, SQL injection surfaces, missing CSRF protection, and XSS vectors. GateTest catches these in under 10 seconds, before the code lands in your repo.

---

## Quick Start

```bash
curl -X POST https://gatetest.ai/api/integrations/ai-generators \
  -H "Authorization: Bearer gt_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "generator": "v0",
    "suite": "quick",
    "files": [
      {
        "path": "app/api/signup/route.ts",
        "content": "export async function POST(req) { const { email, password } = await req.json(); console.log(password); ... }"
      }
    ]
  }'
```

**Response:**
```json
{
  "ok": true,
  "generator": "v0",
  "filesScanned": 1,
  "duration_ms": 1842,
  "findings": [
    {
      "severity": "error",
      "module": "logPii",
      "file": "app/api/signup/route.ts",
      "line": 1,
      "message": "password logged to console",
      "suggestion": "Remove password from log statement"
    }
  ],
  "summary": { "errors": 1, "warnings": 0, "passed": false },
  "badge": "https://gatetest.ai/badge/fail"
}
```

---

## Platform-Specific Setup

### v0 (Vercel)

Add a post-generation step in your v0 workflow or CI:

```typescript
// After v0 generates files, scan before committing
const result = await fetch('https://gatetest.ai/api/integrations/ai-generators', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.GATETEST_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    generator: 'v0',
    suite: 'quick',
    files: generatedFiles.map(f => ({ path: f.path, content: f.content })),
  }),
});

const scan = await result.json();
if (!scan.summary.passed) {
  console.error('GateTest found issues:', scan.findings);
  process.exit(1);
}
```

### Lovable

In your Lovable project, add GateTest as a post-generation webhook:

1. Project Settings → Integrations → Webhooks
2. URL: `https://gatetest.ai/api/integrations/ai-generators`
3. Events: `code.generated`
4. Headers: `Authorization: Bearer gt_your_api_key`

### Bolt.new

Add to your Bolt project's `package.json`:

```json
{
  "scripts": {
    "postgeneate": "node scripts/gatetest-scan.js"
  }
}
```

```javascript
// scripts/gatetest-scan.js
import { readdir, readFile } from 'fs/promises';

const files = await collectFiles('./src');
const res = await fetch('https://gatetest.ai/api/integrations/ai-generators', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.GATETEST_API_KEY}` },
  body: JSON.stringify({ generator: 'bolt', suite: 'security', files }),
});
const { summary, findings } = await res.json();
if (!summary.passed) {
  findings.filter(f => f.severity === 'error').forEach(f => console.error(`❌ ${f.file}:${f.line} — ${f.message}`));
  process.exit(1);
}
```

### Replit Agent

Add a shell command after generation completes:

```bash
# .replit — add to postInstall or run command
gatetest-scan() {
  curl -sf -X POST https://gatetest.ai/api/integrations/ai-generators \
    -H "Authorization: Bearer $GATETEST_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(node -e "
      const fs = require('fs');
      const files = fs.readdirSync('./src', {recursive:true})
        .filter(f => f.endsWith('.js') || f.endsWith('.ts'))
        .map(f => ({ path: f, content: fs.readFileSync('./src/'+f,'utf8') }));
      console.log(JSON.stringify({ generator:'replit', files }));
    ")"
}
```

### Cursor / GitHub Copilot Workspace

Add a pre-commit hook that scans staged files:

```bash
#!/bin/sh
# .husky/pre-commit or .git/hooks/pre-commit

STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|ts|jsx|tsx)$')
if [ -z "$STAGED" ]; then exit 0; fi

FILES_JSON=$(echo "$STAGED" | while read f; do
  echo "{\"path\":\"$f\",\"content\":$(cat "$f" | jq -Rs .)}"
done | jq -s '.')

RESULT=$(curl -sf -X POST https://gatetest.ai/api/integrations/ai-generators \
  -H "Authorization: Bearer $GATETEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"generator\":\"cursor\",\"files\":$FILES_JSON}")

ERRORS=$(echo "$RESULT" | jq '.summary.errors')
if [ "$ERRORS" -gt 0 ]; then
  echo "GateTest found $ERRORS error(s):"
  echo "$RESULT" | jq -r '.findings[] | select(.severity=="error") | "  ❌ \(.file):\(.line) \(.message)"'
  exit 1
fi
```

---

## API Reference

### POST /api/integrations/ai-generators

**Auth:** `Authorization: Bearer gt_<key>` or `"apiKey"` in body.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `generator` | string | No | Source platform: `v0`, `lovable`, `bolt`, `replit`, `cursor`, `copilot`, `other` |
| `files` | array | Yes | Up to 50 files: `[{ path, content }]` |
| `suite` | string | No | `quick` (default), `security`, `full` |
| `apiKey` | string | No | API key (prefer Authorization header) |

**Limits:**
- Max 50 files per request
- Max 200 KB per file
- Max 2 MB total

**Finding severities:** `error` (blocks merge), `warning` (review needed), `info` (advisory).

---

## Getting an API Key

API keys are currently issued manually. Email hello@gatetest.ai with your use case, or use your Nuclear tier admin password as a key during development.

Format: `gt_<32+ hex characters>`
