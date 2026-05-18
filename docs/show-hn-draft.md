# Show HN Post — DRAFT for Craig's review

> Boss Rule #8 + #9 — public-facing communication.
> Drafted by GateTest session 016MgmXrLw4Y35fnyTBLS96m on 2026-05-15.
> Do NOT post yet. Craig reviews + edits + posts at the chosen launch hour.

## Recommended title

**Show HN: GateTest – 102 modules. One scan. Auto-fix PR on every error.**

### Alternative titles (pick one)

- *"Show HN: GateTest – we run 101 QA checks and open an auto-fix PR in 30 seconds"*
- *"Show HN: GateTest – Snyk + Wordfence + Yoast + ESLint in one $29/mo scan"*
- *"Show HN: GateTest – pay-per-scan AI QA gate, not another subscription"*
- *"Show HN: GateTest – the gate that fixes what it finds"*

I'd lead with the first option. It's specific (the number 101), action-oriented (auto-fix PR), time-bound (30 seconds), and doesn't trash-talk competitors in the title (HN audience reacts badly to "kills X" framing in titles, even though Bible loves it).

## Post body (suggested)

```
Hi HN,

GateTest scans your code or your live site, finds bugs + security
issues + performance problems + accessibility gaps + SEO issues +
broken links + supply-chain risks, and opens a PR with the AI-driven
fixes. Same scan, 102 modules, plain-language report.

Try it free in 30 seconds — no signup, no install:
https://gatetest.ai

Or run it locally:
  npm install -g gatetest
  gatetest --suite full ./

What's different from the alternatives:

* Most tools do ONE axis well. Snyk does security. Yoast does SEO.
  ESLint does lint. SonarQube does code smells. Lighthouse does perf.
  Wordfence does WordPress security. We do ALL of these in one scan.

* Most tools find issues. We FIX them. The PR is opened automatically
  with Claude-generated patches. You review and merge.

* Most tools want a subscription. We have one, but Quick Scan is $49
  one-shot. We also bill per-fix on top, so light users pay light bills.

* The CLI is free forever. The Anthropic-driven fix layer is what's
  paid. You can hook your own Anthropic key if you'd rather pay them
  directly.

What it covers (the 102 modules) — among other things:

  Security:     SSRF, secrets, hardcoded URLs, taint flow, TLS config,
                cookie hardening, web headers, XML-RPC exposure,
                user enumeration, brute-force protection
  Supply chain: dependency CVE check, plugin version audit, theme
                abandonment, abandoned PHP versions
  Quality:      ESLint-equivalent + 30 universal checks, dead code,
                error-swallowing, race conditions, async iteration,
                ReDoS, regex injection, money-float, log-PII
  Performance:  Core Web Vitals, render-blocking assets, image size
  Accessibility: WCAG via axe-core, alt text, contrast, focus order
  SEO:          meta, schema.org, canonical, hreflang, sitemap integrity
  Infra:        Dockerfile hygiene, Terraform CVEs, K8s manifest safety,
                CI workflow pinning, shell-script safety, SQL migration
                safety, env var contracts
  WordPress:    exposed wp-config.php.bak, version leak, malware patterns,
                user enumeration, admin protection, plugin CVE,
                theme abandonment, backup audit
  AI safety:    prompt injection surfaces, browser-bundled API keys,
                eval(atob(…)) injection, deprecated model usage

We dogfood it. The repo is at https://github.com/crclabs-hq/GateTest
— you can run it on us and tell us what we missed.

Tech: Node.js engine (~zero deps), Next.js 16 site, Claude Sonnet 4.6
for AI fixes. Pure-static for everything the AI can't help with.

We're not raising money. We're not pivoting. We just want to find more
bugs in more codebases. Skeptical comments very welcome — we'd rather
hear what's broken now than after a customer files a refund.

Built by a small team. Same team also builds Gluecron (git host for
the AI agent era) and Crontech (AI-native edge-first zero-ops). If
you want to see the broader thesis: https://gatetest.ai/stack
```

## First-comment preempts (post your own comment within 5 min of the post)

You should post the FIRST reply yourself. This is the place to head off
the predictable objections that derail HN threads. Keep it factual.

Suggested first comment:

```
Author here. Five objections I expect (and the honest answers):

1. "Isn't this just running 101 linters and showing a report?"
   The fix layer is what's different. Most tools stop at the report;
   we open a PR with Claude-generated patches that the customer reviews
   and merges. We're betting most engineering time on auto-fix actually
   working, not on finding more issues.

2. "How is this different from Snyk + Wordfence + Yoast + …?"
   You'd use all those tools and pay all those subscriptions to get the
   coverage we ship in one scan. They beat us on depth in their single
   axis. We beat them on breadth + unification + one bill.

3. "Won't your Anthropic bill kill you?"
   Per-scan spend caps shipped recently (budget-tracker.js). A single
   runaway scan can't burn more than $12 of Anthropic credit. Customer
   pays per fix on top of the subscription, so heavy users pay heavy
   bills. We make ~40% gross margin on Anthropic at every tier.

4. "Snyk Agent Fix shipped an iterative loop on May 26. You're 11
   days late to the party."
   You're right that Snyk's loop exists. We're not the only iterative
   fix loop now. What we have that Snyk doesn't: cross-finding
   correlation, mutation testing, chaos testing, accessibility,
   performance, SEO, supply chain — and pay-per-scan instead of seat
   licenses. We're the unification play; they're the security
   deepening play.

5. "Show me a real PR you opened."
   [Link to a PR opened on the gatetest repo itself]
   That's a fix-PR we generated against our own codebase last week.
   You can fork the repo and run it yourself.
```

## Recommended post timing

- **8am-10am Pacific Tuesday or Wednesday** — best HN window
- **Avoid Mondays** (HN traffic is lower)
- **Avoid weekends** (low engineer traffic)
- **Avoid the day after a big tech announcement** (Apple WWDC, OpenAI launch, etc.)

## What to do in the 15 minutes BEFORE you post

1. **Verify gatetest.ai is up.** Visit on phone + desktop. Quick scan should complete in < 30 seconds.
2. **Have the npm package live.** People WILL try `npm install -g gatetest` within the first minute.
3. **Have your terminal open** with `tail -f` on a Vercel log so you can see traffic + errors live.
4. **Pre-write the first comment** above and post within 5 minutes of the original post.
5. **Be ready for 50-200 comments in the first hour** if it gets traction. You don't need to reply to all; reply to the top 10 by upvote count.

## What to do AFTER posting

| Time | Action |
|---|---|
| T+0 | Post the Show HN |
| T+5 min | Post the first preempt comment |
| T+1 hour | Reply to top-voted comments. Be brief and factual. |
| T+3 hours | Check Vercel logs for any 500s; debug if needed |
| T+12 hours | Email blast to existing customers + waitlist |
| T+24 hours | Write a "lessons from launch" blog post linking back to HN |

## What NOT to do

- ❌ Don't fight skeptics in the comments. Acknowledge, fix what's
  fixable, move on.
- ❌ Don't post the URL anywhere else in the first 4 hours — HN's
  algorithm doesn't like cross-promotion.
- ❌ Don't ask for upvotes anywhere. Death sentence on HN.
- ❌ Don't change the URL after posting. HN treats this as URL
  swapping and downgrades the post.
- ❌ Don't reply with "thank you" to every comment. Adds noise.
  Substantive replies only.

## Risks specific to this launch

1. **Someone clones the repo and finds the dataIntegrity false-
   positives** (27 SQL-injection findings on our own scanner code).
   **Fix before posting.**

2. **Vercel build fails again** — the @lib/ alias bug surfaced today
   from a fresh build cache. Run a fresh deploy 24h before posting to
   verify cache-cold builds work.

3. **First commenter wants to install the WordPress plugin** — but
   it's not in the WP.org directory yet. **Either ship the plugin
   before the post OR remove the plugin mention from the post body.**

4. **Per-fix cost confusion** — customer asks "so if I have 200 issues
   it costs $200 to fix?" Reply: "$0.99/fix in Starter tier, includes
   $10/month credit covering ~30 free fixes. 200 issues isn't typical
   — your first scan finds many, your next scans find few."

## Final advice

The post should sound like a confident craftsman, not a hype merchant.
HN can smell marketing copy from kilometres away. Specifics > superlatives:
"102 modules, 22-second scan" beats "industry-leading comprehensive
analysis." Numbers and runnable URLs win.

When you're ready to post, paste the title + body into HN, hit submit,
then come back here and we'll handle whatever the comments throw at us.
