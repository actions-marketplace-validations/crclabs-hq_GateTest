# Competitive Sweep — May 2026

> Refresh of the April 2026 thesis. The window is narrowing in some places
> (Snyk shipping iterative-loop in 13 days), still wide open in others.

**Sweep date:** 2026-05-13
**Method:** WebSearch on the closest competitor surfaces + targeted reads of vendor docs / blogs / 2026 review roundups
**Conclusion in one sentence:** the iterative-loop moat is closing — but cross-finding correlation, pay-on-completion, mutation-in-gate, and chaos-in-gate remain unique.

---

## What changed since April

### Snyk Agent Fix — iterative loop shipping 2026-05-26 (13 DAYS)

**Source:** [New Agentic Architecture for Snyk Agent Fix](https://snyk.io/blog/snyk-agent-fix-agentic-architecture/)

Snyk's announcement is explicit: "Snyk Agent Fix arrives May 26th, 2026". They describe:
- A "fix loop" that stress-tests fixes inside the engine before returning to the dev
- Dynamic few-shot prompting that replaces their old static fine-tuning
- Agentic reasoning over a frontier model (model name not disclosed)
- "Full rule and language coverage for every language supported by Snyk Code" — Java, Python, Apex, Go, plus the rest

**Impact on GateTest's thesis:** the April 2026 line *"nobody on the market today ships scan → iterative-self-validating-fix-loop"* expires on 2026-05-26. We need to be on the record about this BEFORE that date. Honest positioning is now:

> "Iterative fix loops are emerging in 2026 — Snyk shipped theirs in late May. GateTest's loop pairs with cross-finding correlation, mutation testing, chaos testing, and pay-on-completion pricing in a single tool. No competitor unifies that depth."

### GitHub Copilot Autofix — still CodeQL-bound, going usage-based

**Sources:** [Responsible use of Copilot Autofix for code scanning](https://docs.github.com/en/code-security/responsible-use/responsible-use-autofix-code-scanning), [GitHub Copilot is moving to usage-based billing](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)

- Still a "subset of queries included in the default and security-extended CodeQL query suites"
- 9 languages: C#, C/C++, Go, Java/Kotlin, Swift, JS/TS, Python, Ruby, Rust
- Requires GitHub Advanced Security (separate license from Copilot)
- **Pricing change 2026-06-01:** Copilot moves to usage-based billing (tokens in/out) — AI Credits + paid usage. Customer cost becomes unpredictable.

**Impact:** Copilot Autofix is still the "CodeQL-narrow" tool we positioned against in April. Their pricing instability (usage-based) makes our flat pay-on-completion clearer to a buyer comparing TCO.

### Greptile — 82% bug catch rate via full-codebase graph indexing

**Source:** [The Best AI Code Review Tools in 2026 (Updated April)](https://medium.com/@lewis_75321/the-best-ai-code-review-tools-in-2026-599c7dd1b305)

Greptile builds a graph of functions/classes/dependencies across the whole codebase, not just the PR diff. Per the cited 2026 benchmark they claim "the highest bug catch rate of any tool tested with an 82% bug catch rate." This is structurally similar to our codebase memory (`src/core/memory.js`) + `importCycle` module + AI review's fix-pattern recall.

**Impact:** Greptile validates that whole-codebase context > diff-only context. Their moat is **per-customer**: their AI sees one customer's codebase at a time. **Our memory layer's planned cross-customer extension (Memory-as-a-Service, Tier 2 Boss Rule) goes beyond them** — Claude sees patterns across ALL customer codebases.

### CodeRabbit — 2M+ repos installed, no security

**Source:** [Best AI Code Review Tools in 2026: 6 Options Tested](https://awesomeagents.ai/tools/best-ai-code-review-tools-2026/)

CodeRabbit has the distribution lead — "the most installed AI code review app on GitHub, with over 2 million repositories connected. Works across GitHub, GitLab, Bitbucket, and Azure DevOps." But: "Choose CodeRabbit if you want free AI PR comments to supplement human review and don't need security scanning, secrets detection, or platform features beyond review."

**Impact:** CodeRabbit is the price/distribution play; GateTest is the depth play. They don't ship security scanning, secrets detection, mutation, chaos, or fix-PR generation. Different category in practice; same buyer occasionally.

### DeepSource — $30/user/month with autofix + AI review

**Sources:** [7 Best AI Code Review Tools for 2026](https://deepsource.com/resources/ai-code-review-tools), [The Best AI Code Review Tools in 2026](https://medium.com/@lewis_75321/the-best-ai-code-review-tools-in-2026-599c7dd1b305)

5,000+ deterministic static analysis rules + AI review + autofix, 20+ languages. Claims the lowest false-positive rate. Per-seat pricing.

**Impact:** DeepSource is the closest "many rules + autofix" competitor. They beat us on raw rule count (5,000 vs our 102 modules — different unit; their rules are atomic, our modules are families). They lose to us on: pay-on-completion, mutation testing, chaos, cross-finding correlation, Nuclear-tier diagnosis depth.

### Sweep — open-source, BYOM

**Source:** [The Best AI Code Review Tools of 2026](https://dev.to/heraldofsolace/the-best-ai-code-review-tools-of-2026-2mb3)

Open-source. Customer picks the model, runs the infra, owns the prompt template. Different buyer profile entirely — DIY teams who want to control their stack.

**Impact:** Not a direct competitor for our buyer.

---

## What's still uniquely GateTest in May 2026

| Capability | GateTest | Snyk Agent Fix | Copilot Autofix | DeepSource | Greptile | CodeRabbit |
|---|---|---|---|---|---|---|
| Iterative fix loop | ✅ (since April) | ✅ (May 26) | ❌ | ❌ | ❌ | ❌ |
| Cross-finding correlation (attack chains) | ✅ ($399 Nuclear) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Mutation testing in gate | ✅ ($399 Nuclear) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Chaos / fuzz in gate | ✅ ($399 Nuclear) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Executive summary single-doc | ✅ ($399 Nuclear) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Pay-on-completion | ✅ ($29/99/199/399 per scan) | ❌ (per-developer seat) | ❌ (GHAS seat) | ❌ ($30/seat/mo) | ❌ (seat) | ❌ (seat) |
| All-in-one (QA + sec + perf + a11y) | ✅ 102 modules | partial (security only) | ❌ (security only) | partial (no perf/a11y) | ❌ (review only) | ❌ (review only) |
| Self-improving fix pattern library | ✅ (this week — `lib/fix-pattern-recall.js`) | partial (dynamic few-shot) | ❌ | partial | partial (graph index) | ❌ |
| Tech-stack auto-detection in prompt | ✅ (this week — `lib/stack-detector.js`) | ? (not documented) | ❌ | ❌ | ✅ (implicit via graph) | partial |
| Per-scan spend cap | ✅ (this week — `lib/budget-tracker.js`) | n/a (different pricing) | n/a | n/a | n/a | n/a |
| Cryptographic audit log | ✅ (this week — `lib/audit-log-store.js`) | partial (SOC2) | ✅ (GH audit) | partial | ❌ | ❌ |

---

## Emerging threats GateTest should respond to

### Shai-Hulud npm worm + supply-chain wave

**Sources:** [TanStack npm Packages Hit by Mini Shai-Hulud](https://snyk.io/blog/tanstack-npm-packages-compromised/), [The npm Threat Landscape](https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/)

Multiple npm supply-chain compromises in 2026 using the Shai-Hulud worm toolchain. Trivy itself was compromised in March. Vercel had an OAuth supply-chain breach in April.

**GateTest action:** the `dependencies` and `secrets` modules already flag npm package issues, but we don't have a dedicated "compromised-package check" against a curated bad-list. Action item: a new module that cross-references customer `package.json` against an actively-maintained list of known-compromised package versions. **Module #92 candidate — pre-authorized to scaffold.**

### Agent-skill backdoors (OpenClaw class)

**Source:** [One command turns any open-source repo into an AI agent backdoor — OpenClaw proved no supply-chain scanner has a detection category for it](https://venturebeat.com/security/one-command-open-source-repo-ai-agent-backdoor-openclaw-supply-chain-scanner)

"A poisoned skill definition does not trigger a CVE and never appears in a SBOM, and no mainstream security scanner has a detection category for malicious instructions embedded in agent skill definitions."

**GateTest action:** **Module #93 candidate.** Scan for `.cursorrules`, `.claude/`, `AGENTS.md`, `system-prompt.md`, MCP-skill JSON, slash-command markdown, etc., flagging suspicious instruction sequences (exfil URLs, secret-leaking phrases, override directives). Pre-authorized to scaffold — fits within the prompt-safety module's lineage.

### Cross-source detection gap

**Source:** [Alert correlation for intelligent threat detection and response (ScienceDirect 2026)](https://www.sciencedirect.com/science/article/pii/S2667305325001322)

Academic finding: "Single-source telemetry has structural limits... best single log source covers less than 40% of advanced supply-chain attack steps; complementary two-source pairing lifts reconstruction to approximately 64%."

**Implication for GateTest's positioning:** our cross-finding correlator is structurally the right direction. The market is converging on the same idea. We have a 6-12 month head start to make this our signature feature. **Action: write a public "How GateTest correlates findings" blog/post once Boss Rule B (marketing copy) ships.**

---

## Recommended messaging update

The April 2026 thesis line dies on 2026-05-26 when Snyk Agent Fix ships. Suggested replacement (pre-authorized to draft; Craig must approve the public copy per Boss Rule #8 before it lands on the website):

> **"Snyk Code is the security scanner. CodeRabbit is the AI reviewer. GateTest is everything else — and the only one that bills by the scan instead of the seat."**
>
> One tool. 102 modules. Security, quality, performance, accessibility, supply chain, AI-safety. Iterative fix loop with mutation testing, chaos testing, and cross-finding correlation in the Nuclear tier. Pay $29 / $99 / $199 / $399 per scan — no subscriptions, no seats, no surprises.

---

## Action items spinning out of this sweep

| # | Action | Pre-authorized? |
|---|---|---|
| 1 | Module #92 — compromised-package version blacklist check (Shai-Hulud class) | ✅ within prompt-safety/dependencies lineage |
| 2 | Module #93 — AI-agent-skill backdoor detector (OpenClaw class) | ✅ within prompt-safety lineage |
| 3 | Public "How GateTest correlates findings" comparison doc | ❌ Boss Rule #8 — brand/marketing copy |
| 4 | Update homepage messaging before 2026-05-26 to ride the Snyk Agent Fix news | ❌ Boss Rule #8 |
| 5 | Submit GateTest to G2 / Capterra / Awesome-AI-Code-Review-Tools roundups | ❌ Boss Rule #8 — public-facing comms |
| 6 | Verify our `compromised-package` check catches the TanStack / Trivy / Vercel CVEs from search | ✅ test-only, no new public surface |

---

## Sources

- [New Agentic Architecture for Snyk Agent Fix](https://snyk.io/blog/snyk-agent-fix-agentic-architecture/) — Snyk Agent Fix iterative loop ships 2026-05-26
- [Snyk autofix | AI code security improvements to DeepCode AI Fix](https://snyk.io/blog/ai-code-security-snyk-autofix-deepcode-ai/)
- [Snyk Code Security Analysis & Fixes](https://snyk.io/product/snyk-code/)
- [Responsible use of Copilot Autofix for code scanning](https://docs.github.com/en/code-security/responsible-use/responsible-use-autofix-code-scanning)
- [GitHub Copilot is moving to usage-based billing](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)
- [GitHub Copilot Plans & pricing](https://github.com/features/copilot/plans)
- [7 Best AI Code Review Tools for 2026 (DeepSource)](https://deepsource.com/resources/ai-code-review-tools)
- [The Best AI Code Review Tools of 2026 (DEV)](https://dev.to/heraldofsolace/the-best-ai-code-review-tools-of-2026-2mb3)
- [Best AI Code Review Tools in 2026: 6 Options Tested](https://awesomeagents.ai/tools/best-ai-code-review-tools-2026/)
- [The Best AI Code Review Tools in 2026 (Medium, Apr update)](https://medium.com/@lewis_75321/the-best-ai-code-review-tools-in-2026-599c7dd1b305)
- [TanStack npm Packages Hit by Mini Shai-Hulud (Snyk)](https://snyk.io/blog/tanstack-npm-packages-compromised/)
- [Microsoft Security Blog: Detecting Trivy supply chain compromise](https://www.microsoft.com/en-us/security/blog/2026/03/24/detecting-investigating-defending-against-trivy-supply-chain-compromise/)
- [The Vercel Breach: OAuth Supply Chain Attack (Trend Micro)](https://www.trendmicro.com/en_us/research/26/d/vercel-breach-oauth-supply-chain.html)
- [OpenClaw — AI agent backdoors with no scanner category (VentureBeat)](https://venturebeat.com/security/one-command-open-source-repo-ai-agent-backdoor-openclaw-supply-chain-scanner)
- [Alert correlation for threat detection (ScienceDirect 2026)](https://www.sciencedirect.com/science/article/pii/S2667305325001322)
- [Aikido top DevSecOps tools 2026](https://www.aikido.dev/blog/top-devsecops-tools)
