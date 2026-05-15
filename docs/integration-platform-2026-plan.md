# GateTest as a Platform — 2026 Integration Architecture

> Authorisation: Craig 2026-05-15 — *"we need to set it up the integration up so any website can connect to it straight away ... I got so many platforms waiting to connect to this one So we need to get this done ASAP this is urgent."*
>
> Locks in the standard for how OTHER platforms integrate with GateTest. Every integration partner — Gluecron, Crontech, future SaaS partners — follows this contract.

## The two directions

| Direction | Who initiates | Who has the customer | What flows |
|---|---|---|---|
| **A. GateTest → git host** | GateTest | The git host (GitHub, GitLab, Bitbucket, Gluecron) | GateTest acts on customer repos using OAuth tokens issued by the host |
| **B. Third-party → GateTest** | Third-party app | GateTest | Partner apps call GateTest's API using OAuth tokens issued by GateTest |

Direction B is what "any website can connect to GateTest" means. Direction A is what "GateTest can scan any customer's repo" means. **We need both.** Direction B is more urgent (Craig has partners waiting).

## The four pillars (every modern SaaS integration uses all four)

### 1. OAuth 2.0 provider — GateTest issues tokens

```
Partner app registers at:        gatetest.ai/developers/apps/new
  → gets client_id + client_secret

Partner sends user to:           https://gatetest.ai/oauth/authorize?
                                   response_type=code&
                                   client_id=<partner_id>&
                                   redirect_uri=<partner_callback>&
                                   scope=scan:run+fix:create&
                                   state=<random>

GateTest asks user:              "Partner X wants to scan repos + create fix
                                  PRs on your behalf. Allow?"

User clicks Allow.
GateTest redirects:              <partner_callback>?code=<auth_code>&state=<random>

Partner exchanges code:          POST https://gatetest.ai/api/v1/oauth/token
                                   { grant_type, code, client_id, client_secret }
                                 → { access_token, refresh_token, expires_in,
                                     scope, token_type: "Bearer" }

Partner makes API calls:         GET https://gatetest.ai/api/v1/account
                                   Authorization: Bearer <access_token>
```

### 2. REST API with OAuth-bearer auth

```
Public endpoints (all require Bearer token in Authorization header):

  Account
    GET    /api/v1/account                       — get authenticated user info
    GET    /api/v1/account/scans                 — list scans
    GET    /api/v1/account/balance               — remaining fix credit

  Scans
    POST   /api/v1/scans                         — start a scan
    GET    /api/v1/scans/:id                     — get scan status + results
    GET    /api/v1/scans/:id/findings            — list findings
    POST   /api/v1/scans/:id/fixes               — trigger AI fix for findings
    GET    /api/v1/scans/:id/health-score        — get the 0-100 score

  Webhooks
    POST   /api/v1/webhooks                      — register a webhook
    GET    /api/v1/webhooks                      — list registered webhooks
    DELETE /api/v1/webhooks/:id                  — unregister

  Health
    GET    /api/v1/health                        — unauthenticated; status check
```

### 3. Webhooks — GateTest notifies partners

```
On every scan-related event, GateTest POSTs to the partner's registered URL:

  POST <partner_webhook_url>
  Headers:
    X-GateTest-Event:     scan.completed
    X-GateTest-Delivery:  <uuid>
    X-GateTest-Signature: sha256=<hmac-hex>
  Body: {
    event: "scan.completed",
    scanId: "scn_abc123",
    user: { id, email },
    repository: { owner, repo },
    findings: { errors: 5, warnings: 12, info: 3 },
    healthScore: 73,
    timestamp: "2026-05-15T...",
  }

Events partners can subscribe to:
  scan.queued             — scan created, waiting to run
  scan.started            — scan is running
  scan.completed          — scan finished successfully
  scan.failed             — scan errored
  fix.pr_opened           — auto-fix PR was created on a repo
  billing.credit_topped_up
  account.connected       — user authorized a new git host
```

Partner verifies HMAC against the body+secret they were given at registration.

### 4. Developer platform — registration, docs, sandbox

```
gatetest.ai/developers          — landing for integration developers
gatetest.ai/developers/apps     — list of apps the developer owns
gatetest.ai/developers/apps/new — register a new OAuth app
gatetest.ai/developers/docs     — full API + webhook + OAuth reference
gatetest.ai/developers/sandbox  — try API calls against a test environment
```

This is the developer surface — what they hit when they want to integrate.

## OAuth scopes — proposed catalogue (Boss Rule #9, your sign-off)

| Scope | What it allows | Risk |
|---|---|---|
| `account:read` | Read user profile (email, name, plan) | Low |
| `scan:run` | Start scans on the user's behalf | Medium — costs credit |
| `scan:read` | Read existing scan results | Low |
| `fix:create` | Trigger AI auto-fix on findings | High — costs credit + writes to repos |
| `fix:read` | Read fix PR history | Low |
| `billing:read` | Read balance + invoices | Medium — sensitive |
| `webhooks:manage` | Register / unregister webhooks | Low |
| `gitlab:connect` `github:connect` `gluecron:connect` | Allow partner to bind a git host to the user account | Medium — gives partner indirect access to repos |

Default-issued scopes for new apps: `account:read scan:read`. Anything that writes or costs money requires explicit user consent during OAuth.

## Rate limiting — per partner, per scope

| Tier | Scans / hour | Fix-PRs / day | Webhook deliveries / hour |
|---|---|---|---|
| Free dev / Sandbox | 10 | 5 | 100 |
| Standard | 100 | 50 | 1000 |
| Partner | 1000 | 500 | 10,000 |
| Enterprise | Negotiated | Negotiated | Negotiated |

Sandbox mode: free, rate-limited, no real Anthropic spend (returns canned results). Lets partners build their integration before going live.

## Phasing — what ships when

### Phase 1 (this session — foundation)

| # | Deliverable | Hours |
|---|---|---|
| 1 | This planning doc | 1 |
| 2 | OAuth provider schema: `oauth_apps`, `oauth_tokens`, `oauth_authorizations` tables | 1 |
| 3 | `/api/v1/oauth/authorize` + `/api/v1/oauth/token` endpoints | 2 |
| 4 | `/api/v1/scans` — POST + GET endpoints with Bearer auth | 1.5 |
| 5 | `/developers` landing page | 1.5 |
| 6 | Doctor checks for OAuth env vars | 0.5 |

**Phase 1 total: ~7-8 hours.** Lands as one PR.

### Phase 2 (next session — partner-facing surface)

| # | Deliverable | Hours |
|---|---|---|
| 7 | `/developers/apps/new` registration UI | 2 |
| 8 | App management dashboard | 2 |
| 9 | Webhook delivery infrastructure | 3 |
| 10 | Public API docs at `/developers/docs` | 3 |
| 11 | First SDK (npm package: `@gatetest/sdk`) | 2 |

**Phase 2 total: ~12 hours.**

### Phase 3 (third session — git host adapters)

| # | Deliverable | Hours |
|---|---|---|
| 12 | OAuth client for GitHub (customer connects their GitHub account) | 3 |
| 13 | OAuth client for GitLab | 3 |
| 14 | OAuth client for Bitbucket | 3 |
| 15 | OAuth client for Gluecron | 2 |
| 16 | Encrypted per-customer token storage | 2 |

**Phase 3 total: ~13 hours.**

### Phase 4 (fourth session — production hardening)

| # | Deliverable | Hours |
|---|---|---|
| 17 | Rate limiter per-client | 2 |
| 18 | Token refresh worker | 2 |
| 19 | Audit-log every OAuth grant + token use | 1 |
| 20 | Sandbox environment | 3 |
| 21 | Partner onboarding doc | 2 |

**Phase 4 total: ~10 hours.**

**Grand total: ~42-43 hours of focused engineering across 4 sessions.**

## What needs your sign-off (Boss Rule)

| # | Item | Boss Rule | When needed |
|---|---|---|---|
| 1 | Public API surface (the endpoints + auth model) | #1 (major architectural) | Now — confirm before Phase 1 |
| 2 | OAuth scope catalogue | #9 (user data access) | Phase 1 |
| 3 | `/developers` brand / copy | #8 | Phase 2 |
| 4 | Rate limit tier pricing | #3 | Phase 4 |
| 5 | Public API docs copy | #8 | Phase 2 |
| 6 | `oauth_apps` + `oauth_tokens` Postgres tables | #9 (user data store — same kind you authorised for audit_log) | Phase 1 |

## What I need from you to start Phase 1

Three answers, 60 seconds each:

1. **Sign off on the architecture** above (OAuth + REST + Webhooks + Developer Platform). If you want to swap something fundamental, now is the moment.
2. **Sign off on the proposed scope catalogue** (or send me your version).
3. **Tell me the priority order for Phase 3 git hosts**: GitHub first, then GitLab+Bitbucket, then Gluecron — OK?

Once those land I start Phase 1 immediately. By end of next session you have a working OAuth provider + the first public API endpoint + the `/developers` page. Real partners can start registering against the sandbox.

## Following the standard practice — verified prerequisites

| # | Need | State |
|---|---|---|
| Postgres for the OAuth tables | ✅ already in use (audit_log) |
| Stripe for billing-credit linkage to API usage | ⚠ requires the Hybrid pricing model you haven't approved yet — Phase 4 can defer this |
| HMAC signing infrastructure | ✅ already in use (webhook receiver) |
| Encryption-at-rest for client secrets | ⚠ requires a master key in Vercel env vars — needs your hand |
| Bearer-token middleware on API routes | ⚠ needs building — Phase 1 |
| `gatetest --doctor` checks for the new env vars (`OAUTH_*`, `GATETEST_API_BASE`) | ⚠ adds in Phase 1 per standard practice |

## Open questions for future me / future sessions

- Should we support PKCE (PKCE = Proof Key for Code Exchange) for native / mobile clients? Best practice says yes.
- JWT or opaque tokens? Opaque is simpler; JWT scales better. Defaulting to opaque (random hex) for v1.
- Should the API be versioned (`/api/v1/...`) or feature-flagged? Versioning is simpler and clearer.
- Should we expose GraphQL alongside REST? Skip for v1. Add if partners ask.
- WebSocket / SSE for real-time scan progress? Skip for v1. Webhook delivery is enough.
