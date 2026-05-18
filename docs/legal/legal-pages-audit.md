# Legal pages completeness audit

Generated: 2026-05-17 (current session date 2026-05-18)
Auditor: read-only, structural-completeness only (NOT legal advice)

## Summary

- Pages present: terms (YES), privacy (YES), refunds (YES), acceptable-use (YES — bonus, not in scope brief)
- Total sections in each: terms 29, privacy 19 (incl. duplicate "Data Security"), refunds 10, acceptable-use 12
- Required sections missing: 4 structural blockers + ~12 weak/TBC sections (see per-page tables)
- Cross-page consistency issues: 1 (legal entity / postal address blank everywhere)
- Linkage issues (not linked from footer/checkout/free-scan): **5 (severity 1)**
- Severity 1 blockers (must-fix-before-launch): **8**

The legal pages themselves are well-drafted for operator-authored drafts pre-attorney. The biggest gaps are NOT inside the documents — they are the structural surrounds: linkage from checkout, linkage of refunds + acceptable-use from the footer, an actual legal entity / postal address, and the missing DPA template / SLA / Do-Not-Sell form-page.

---

## Terms of Service: website/app/legal/terms/page.tsx

**Overall verdict:** strong operator-draft. 29 numbered sections cover almost every required area. Several sections carry self-aware "DRAFT — requires attorney review" callouts which is exactly the right posture. Two blockers: no named legal entity, and an arbitration-opt-out clause that admits a postal address is "to be confirmed in final Terms."

| # | Required section | Present? | Quality | Notes |
|---|---|---|---|---|
| 1 | Definitions | YES | adequate | "Customer", "Service", "Terms" defined in §1; "GateTest Parties" in §10. No formal definitions block — terms are defined inline first-use. Acceptable for B2C; enterprise lawyer may want a §0 definitions block. |
| 2 | Service description | YES | strong | §2 — clear "automated tool, not professional advice" framing. |
| 3 | Acceptance / formation | YES | strong | §1 "by accessing or using…you agree" + organisation-binding warranty. |
| 4 | License grant | PARTIAL | weak | §5.2 grants licence to use scan reports. No explicit licence grant for the Service itself (use of website / CLI / API). The CLI's MIT licence is mentioned (§15). The hosted Service has no explicit licence-grant clause naming it as a non-exclusive, non-transferable, revocable right. |
| 5 | Customer obligations | YES | strong | §4.3 authorisation warranty + §11 acceptable-use list (11 bullets). |
| 6 | Payment terms | YES | strong | §3 (5 sub-paragraphs), §16, §17, §18 — hold-then-charge spelled out clearly. |
| 7 | Refunds | YES | adequate | §12.4 mentions "fees paid…non-refundable except where statutory consumer right applies." Does NOT cross-link to /legal/refunds. Should add `<Link>` to refund policy. |
| 8 | Acceptable use | YES | strong | §11 — 11-bullet prohibited-use list. Also separate /legal/acceptable-use page (good defence-in-depth). |
| 9 | Disclaimer of warranties | YES | strong | §6 in all-caps. §6.1/6.2/6.3 enumerate the specific no-warranty surfaces. |
| 10 | Limitation of liability | YES | strong | §9 — $100/12-month-fees cap, consequential exclusion, essential-basis statement. Attorney-review flag on the cap floor. |
| 11 | Indemnification | YES | strong | §10 — one-way (customer indemnifies GateTest). Attorney flag on mutual-indemnity option. Includes control-of-defence + survival. |
| 12 | IP | YES | strong | §5.1 / 5.2 / 5.3 — customer keeps code, GateTest keeps engine, scan reports licensed to customer. |
| 13 | AI disclaimer | YES | strong | §8 (4 sub-paragraphs) — probabilistic output, not professional advice, no guarantee of findings, customer responsibility. |
| 14 | Compliance disclaimer | PARTIAL | adequate | §2 mentions "does not constitute…legal compliance certification" and §8.2 names accounting/legal/engineering advice exclusions. **No explicit "WCAG / HIPAA / SOC 2 / PCI-DSS / GDPR are not certified by a passing scan" clause.** Recommend adding given that accessibility, security, web-headers modules will tempt customers to read "pass" as "certified." |
| 15 | Termination | YES | strong | §12 — 5 sub-paragraphs. 14-day notice, 30-day data purge. |
| 16 | Modifications | YES | strong | §23 — 30-day notice for material changes, continued-use = consent, attorney-flag noted. |
| 17 | Governing law + venue | YES | strong | §13 — New Zealand law, Auckland venue, CGA carve-out preserved. Attorney flag noted. |
| 18 | Dispute resolution | YES | strong | §19 — informal first, binding arbitration (AAA US / NZIAC RoW), class-waiver, jury waiver, 30-day opt-out, small-claims carve-out. Attorney-review flag is correctly the largest in the doc. |
| 19 | Contact | YES | adequate | §29 — hello@gatetest.ai. **No postal address, no legal entity name.** §27 explicitly says notices are by email — fine for the Service but problematic for legal-process-of-service in many jurisdictions. |

### Critical gaps (Terms)

1. **No legal entity identified.** Document says "GateTest" and "GateTest and its operators." No "GateTest Ltd," "Craig Canty trading as GateTest," LLC, sole-trader, etc. Without a legal entity the indemnity, liability cap, and arbitration clauses identify no recoverable counterparty. **Severity 1.**
2. **Arbitration opt-out postal address explicitly marked TBC.** §19.6: *"GateTest — Arbitration Opt-Out, c/o hello@gatetest.ai (postal address to be confirmed in final Terms)"*. Customer trying to opt out has no postal address; an opt-out provision with no usable channel could be held unconscionable in some forums. **Severity 1.**
3. **No cross-link to refund policy from §12.4 or §3.** Bible Quality Bar #4: "All links verified." Customer reading payment terms can't jump to refund detail. **Severity 2.**
4. **No explicit compliance-tool disclaimer** (WCAG/HIPAA/SOC 2/PCI/GDPR). §8.2 covers "professional advice" generically. Given GateTest's marketing positions accessibility / security / web-headers as compliance-adjacent, a single explicit sentence is the cheapest insurance available. **Severity 2.**
5. **No formal definitions block.** Most US/EU enterprise procurement reviewers expect a §0 or §1 definitions section listing every capitalised term. Currently terms are defined inline first-use. **Severity 3 (procurement friction, not legal risk).**

### Recommended additions (Terms)

- A definitions block (§0): Customer, Service, Affiliate, Confidential Information, Documentation, Personal Data, Sub-processor.
- Cross-link from §3 / §12.4 to /legal/refunds.
- Explicit WCAG/HIPAA/SOC 2/PCI-DSS/GDPR-not-certified clause.
- Postal address (PO box minimum) for §19.6 opt-out and §29 contact.

---

## Privacy Policy: website/app/legal/privacy/page.tsx

**Overall verdict:** the strongest of the four documents. GDPR Art. 13 disclosures, CCPA/CPRA notice, sub-processor table with DPAs and SCC mechanisms, retention schedule, breach-notification commitment, controller/processor characterisation, transfer mechanisms. Two structural defects: a duplicated "Data Security" section (§7 and §14 are near-identical) and a placeholder email-delivery sub-processor.

| # | Required section | Present? | Quality | Notes |
|---|---|---|---|---|
| 1 | What we collect | YES | strong | §2.1/2.2/2.3 — account & payment, repository data, website data. |
| 2 | Why we collect | YES | strong | §3 — six bullets of use, six bullets of "we do NOT" — strong "no training data" stance. |
| 3 | Who we share with (named) | YES | strong | §11 — Stripe, GitHub, Anthropic, Vercel, Cloudflare, Neon listed individually with what-they-see / governed-by / privacy-policy-link. |
| 4 | Retention period | YES | strong | §6 — 8 categories with explicit windows (30 days logs, 7 years payment per NZ tax law, etc.). Attorney-flag noted. |
| 5 | Customer rights (GDPR Art. 15-22) | YES | strong | §8 — 9 rights enumerated, 5-day acknowledgment, 30-day substantive response, multi-statute timelines (NZ 20 working days, GDPR 30 days, CCPA 45 days). |
| 6 | GDPR legal basis (Art. 6) | YES | strong | §13.1 — contract, legitimate interest, consent, legal obligation. Plus Art. 13 disclosures inline. |
| 7 | GDPR DPO / EU representative (Art. 27) | NO | missing | No Art. 27 representative named. NZ-based operator selling to EU MUST appoint an EU representative (Art. 27 GDPR) unless an exemption applies. Same for UK (UK Rep). **Severity 1.** |
| 8 | CCPA "Do Not Sell or Share" link | PARTIAL | weak | §13.2 says *"We do not sell or share your personal information"* — substantively correct. But CCPA still requires an obvious link/form at the point of collection if any sale/share could occur. Cleanest practice = a dedicated `/legal/do-not-sell` page or homepage-footer link. **Severity 2.** |
| 9 | CCPA categories of PI collected | PARTIAL | adequate | §2 lists categories in plain English; CCPA's enumerated categories (identifiers, commercial info, internet activity, etc.) are not explicitly mapped onto §2's categories. Common procurement reviewer ask. **Severity 3.** |
| 10 | Cookies / local storage | YES | strong | §7A — strictly-necessary by default, opt-in non-essential. Attorney-flag noted. **No cookie-consent banner implementation visible in repo** (separate finding below). |
| 11 | Children's privacy | YES | strong | §10 — COPPA + GDPR Art. 8 + UK AADC. |
| 12 | International transfers | YES | strong | §9 — SCCs, IDTA, Swiss FADP clauses, adequacy decisions, NZ Part 1B. Schrems-II flagged for attorney. |
| 13 | Security measures | YES | adequate | §7 — TLS, Stripe, no-disk source, Vercel SOC 2. **Duplicated as §14 — same content reworded.** Either merge or remove §14. **Severity 3.** |
| 14 | Breach notification | YES | strong | §12 — 72-hour regulator, affected-user as soon as practicable, processor-cooperation. Attorney-flag noted on state-specific shorter windows. |
| 15 | Contact (privacy officer) | YES | adequate | §1 + §17 — hello@gatetest.ai. No named privacy officer / DPO. EEA / UK operators above certain thresholds require a named DPO; check NZ Privacy Officer designation under Privacy Act 2020 §201. **Severity 2.** |
| 16 | Effective date | YES | strong | "April 9, 2026" top of page. |
| 17 | Change log | NO | missing | No "previous versions" link or change-log. If §16 has been updated, prior versions should be archivable for evidentiary purposes. **Severity 3.** |
| 18 | Controller vs processor roles | YES | strong | §1A — explicit characterisation, DPA available on request. |
| 19 | Sub-processor change notification | PARTIAL | weak | §11 says material changes "are notified in advance where required by applicable law or your DPA." Best practice = an active sub-processor RSS / email list or `/legal/sub-processors` log. **Severity 3.** |

### Critical gaps (Privacy)

1. **No EU Article 27 representative + no UK Rep.** A NZ-domiciled operator with EU/UK customers needs either a named representative or a documented exemption. Currently absent. **Severity 1.**
2. **Email-delivery sub-processor named as "to be confirmed (e.g. Resend, Postmark, SendGrid)."** A sub-processor list that says "TBC" defeats the purpose. **Severity 1.**
3. **Duplicate "Data Security" sections** §7 and §14. Pick one. Likely a merge artefact. **Severity 3 (cosmetic).**
4. **No `/legal/do-not-sell` form-page** even though substantively "we don't sell." CCPA's form requirement is independent of the actual practice. **Severity 2.**
5. **No named NZ Privacy Officer** as required by Privacy Act 2020 §201. **Severity 2.**
6. **Effective-date consistency.** Privacy says April 9, 2026 — same as terms / refunds / acceptable-use. Consistent.

### Recommended additions (Privacy)

- Section: "EU Representative" naming the appointed representative under GDPR Art. 27 (or documenting why exempt).
- Section: "UK Representative" naming the appointed UK rep under UK GDPR Art. 27.
- Section: "NZ Privacy Officer" naming the §201 officer.
- Confirm and name email-delivery sub-processor.
- Merge or delete the duplicate §14 "Data Security."
- Add `/legal/sub-processors` page with last-updated date so customers can subscribe / monitor changes (Vercel does this, Anthropic does this).
- Add `/legal/do-not-sell-or-share` form-page even if it's a one-line "we do not sell or share — confirm anyway" form.

---

## Refund Policy: website/app/legal/refunds/page.tsx

**Overall verdict:** strong on substance — pay-on-completion is unusual and the doc explains it carefully across 10 sections. Three structural defects: not linked from footer, not in sitemap, chargeback waiver is jurisdiction-fragile.

| # | Required section | Present? | Quality | Notes |
|---|---|---|---|---|
| 1 | Eligibility for refund | YES | strong | §4 — four eligibility scenarios spelled out. |
| 2 | Pay-on-completion clarification | YES | strong | §1 (4-step model) + §2 (failure = automatic release) + §3 (success = delivered + not refundable). Best part of the doc. |
| 3 | How to request | YES | adequate | §4 — email hello@gatetest.ai with scan ID, 7-day window, 3-business-day response. No automated form / dashboard request — fine for launch volume, will need a UI soon. |
| 4 | Timeline | YES | strong | §9 — Stripe processes 5-10 business days. Hold-release timeline (3-7 days, up to 14 in §2) is also documented. |
| 5 | Exceptions (what's NOT refundable) | YES | strong | §5 — five no-refund scenarios with cross-references to Terms §6, §7. |
| 6 | Chargebacks | YES | adequate | §8 — 4 sub-paragraphs. **The §8.2 "waiver of chargeback for scans rendered" is unenforceable against card-network rules in many jurisdictions and against EU consumer-protection regimes; the doc's own DRAFT comment flags this.** **Severity 2.** |
| 7 | Continuous-subscription cancel | YES | strong | §6 — cancel anytime, end-of-period effective, no prorated refunds, failed-payment retry. Cross-refs Terms §18. Attorney-flag should be added for California SB-313 / state automatic-renewal laws (the draft comment already notes this). |
| 8 | Free CLI clarification | YES | strong | §7 — MIT, no refund applies. |
| 9 | Cross-links to other legal docs | YES | strong | Footer of doc links to terms, privacy, acceptable-use. Inverted polarity: the footer of the SITE doesn't link back here (see linkage issues). |
| 10 | Consumer-protection carve-outs | YES | adequate | §3 mentions cooling-off in some jurisdictions; §6 mentions NZ CGA / Australian Consumer Law / EU-UK. Could be stronger. |

### Critical gaps (Refunds)

1. **Refunds page is NOT linked from Footer.tsx.** Footer only links Privacy + Terms. A customer who paid and wants a refund cannot find this page from the site chrome. **Severity 1.**
2. **Refunds page is NOT in sitemap.ts.** Search engines won't index it; nor will support agents find it via site:gatetest.ai. **Severity 1.**
3. **No DPA / SLA reference for enterprise refund triggers.** Enterprise customers will ask: "what's the SLA?" "what's the credit?" Currently no SLA exists (Terms §16 says "99.5% uptime, no service credits"). Fine for launch but flag for first enterprise deal. **Severity 3.**

### Recommended additions (Refunds)

- Add `<Link href="/legal/refunds">` to `website/app/components/Footer.tsx`.
- Add `/legal/refunds` to `website/app/sitemap.ts`.

---

## Acceptable Use Policy: website/app/legal/acceptable-use/page.tsx

**Overall verdict:** clean, standard B2B SaaS AUP. 12 sections. Cross-references Terms §11. Marked attorney-review-light because no unusual provisions. Two issues: same linkage gap as refunds (not in footer, not in sitemap) and one consistency cross-check.

| # | Required section | Present? | Quality | Notes |
|---|---|---|---|---|
| 1 | Purpose | YES | strong | §1 — explicit reference into Terms. |
| 2 | Authorised use | YES | strong | §2 — six bullets. |
| 3 | Prohibited uses | YES | strong | §3.1 to §3.5 — five categories, well-organised. |
| 4 | Responsible disclosure | YES | strong | §4 — 90-day disclosure window, acknowledgment in 5 days, no paid bug-bounty (honest). |
| 5 | Content submitted | YES | strong | §5 — submitter warrants permission. |
| 6 | AI output | YES | strong | §6 — 4-bullet acknowledgment. Aligns with Terms §7 / §8. **Comment in source says "verify Section 7 (AI output) aligns with final Terms of Service Section 7" — attorney action item still open.** |
| 7 | API usage | YES | strong | §7 — credentials, rate-limit, competitive-use prohibition. |
| 8 | GitHub App | YES | strong | §8 — authorisation, immediate revocation. |
| 9 | Consequences | YES | strong | §9 — warning, suspension, termination, legal action, disclosure. |
| 10 | Reporting violations | YES | strong | §10 — email hello@gatetest.ai. |
| 11 | Changes | YES | adequate | §11 — material-change notice via website / email. No 30-day notice commitment matching Terms §23 — minor consistency gap. |
| 12 | Contact | YES | strong | §12. |

### Critical gaps (Acceptable Use)

1. **NOT linked from Footer.tsx.** Footer chrome shows only Privacy + Terms. **Severity 1.**
2. **NOT in sitemap.ts.** **Severity 1.**
3. **Consistency check.** Terms §23 promises 30-day notice for material changes; AUP §11 says "we will notify you" with no specified window. Align with Terms §23. **Severity 3.**

---

## Cross-page consistency

| Field | Terms | Privacy | Refunds | Acceptable Use | Consistent? |
|---|---|---|---|---|---|
| Effective date | April 9, 2026 | April 9, 2026 | April 9, 2026 | April 9, 2026 | YES |
| Legal entity name | "GateTest" / "GateTest and its operators" | "GateTest" | "GateTest" | "GateTest" | YES — but uniformly **missing a real legal entity name across all four** |
| Contact email | hello@gatetest.ai | hello@gatetest.ai | hello@gatetest.ai | hello@gatetest.ai | YES |
| Postal address | TBC (§19.6) + absent (§29) | absent | absent | absent | YES — uniformly absent |
| Governing law | NZ + Auckland venue | NZ (Privacy Act 2020) | implicit via Terms cross-ref | implicit via Terms cross-ref | YES |
| Material-change notice window | 30 days (Terms §23) | 30 days (Privacy §16) | not specified | not specified (AUP §11) | PARTIAL — refunds + AUP don't commit |
| Cooling-off / consumer carve-out | preserved (§13.3) | n/a | preserved (§3, §6) | n/a | YES |

**Cross-page issues found: 2**

- **No legal entity uniformly absent across all four.** Severity 1.
- **Notice window inconsistent.** Terms + Privacy commit 30 days; Refunds + AUP don't. Severity 3.

---

## Structural / linkage issues

| # | Issue | Severity | Location |
|---|---|---|---|
| L1 | Refunds NOT linked from Footer.tsx | 1 | `website/app/components/Footer.tsx` lines 47-53 |
| L2 | Acceptable Use NOT linked from Footer.tsx | 1 | same |
| L3 | Refunds NOT in sitemap.ts (only terms + privacy listed) | 1 | `website/app/sitemap.ts` line 25-26 |
| L4 | Acceptable Use NOT in sitemap.ts | 1 | same |
| L5 | NO legal-page consent / link at checkout point of sale | 1 | `website/app/api/checkout/route.ts` and `website/app/components/Pricing.tsx` contain no terms/privacy reference — confirmed by grep. Stripe Checkout's auto-injected terms link is not a substitute for the operator's own. |
| L6 | NO legal-page link from `/web` or `/wp` free-scan landing pages | 2 | `website/app/web/` and `website/app/wp/` searched — no reference to /legal/* |
| L7 | NO `/legal/refunds` or `/legal/acceptable-use` in `app/sitemap.ts` (covered by L3/L4 but worth noting search-engine visibility) | 1 | same |
| L8 | Footer copyright says "© <year> GateTest" — no legal entity | 2 | `Footer.tsx` line 57-59 |
| L9 | NO cookie-consent banner implementation despite Privacy §7A committing to opt-in for EU/UK/EEA/CH | 2 | searched `components/` — no banner component |
| L10 | NO DPA template referenced or downloadable (Privacy §13.5 says "request one") | 2 | enterprise/EU customer friction |
| L11 | NO SLA document (Terms §16 says "99.5% target, no credits") | 3 | enterprise deal friction, not consumer-legal |
| L12 | NO `/legal/sub-processors` log page (industry standard for sub-processor change tracking) | 3 | none |
| L13 | NO `/legal/do-not-sell-or-share` form (CCPA-form requirement independent of actual no-sell practice) | 2 | none |

**Linkage issues count: 13 (5 at Severity 1, 5 at Severity 2, 3 at Severity 3).**

---

## Severity-1 blocker count (must fix before public launch)

1. **No legal entity named** across all four pages — counterparty unidentifiable.
2. **Arbitration opt-out postal address marked TBC** in Terms §19.6.
3. **No EU Article 27 representative + no UK Rep** named in Privacy.
4. **Email-delivery sub-processor named as "TBC (e.g. Resend, Postmark, SendGrid)"** in Privacy §11.
5. **Refunds NOT linked from Footer.**
6. **Acceptable Use NOT linked from Footer.**
7. **Refunds + Acceptable Use NOT in sitemap.**
8. **No legal-page consent link at point of sale (checkout / pricing).**

The single most urgent missing section is **#8 — terms-consent at checkout.** Stripe Checkout's auto-injected link is not a substitute for the operator's express consent capture. Without a "By clicking Buy you agree to the Terms of Service, Privacy Policy, and Refund Policy" line at the click-to-pay moment, the binding-formation argument in Terms §1 is weak — and a customer disputing a charge can credibly claim they never accepted terms.

---

## Recommended draft additions (starting points for Craig's lawyer, NOT final language)

### Suggested AI / compliance-tool disclaimer (Terms — add as §8.5)

> Scan modules covering accessibility (WCAG / ARIA), security (CWE / OWASP), web headers, HIPAA, SOC 2, PCI-DSS, GDPR-readiness, and similar regulatory subjects are diagnostic tools, not certifications. A passing scan does not constitute compliance with WCAG, HIPAA, SOC 2, PCI-DSS, the GDPR, the NZ Privacy Act 2020, or any other standard. Customers are solely responsible for engaging qualified auditors, lawyers, and compliance officers for formal certification, attestation, or sign-off.

### Suggested legal-entity clause (Terms §1 or §29; mirrored in Privacy §1)

> The Service is operated by [LEGAL ENTITY NAME], a [ENTITY TYPE] registered in [JURISDICTION] under company number [NNNNN], with registered office at [PHYSICAL ADDRESS]. References in these Terms to "GateTest" mean that entity. Notices and legal process may be served on GateTest at [PHYSICAL ADDRESS] or, where electronic service is permitted, at hello@gatetest.ai.

### Suggested EU representative clause (Privacy — add as §13.1A)

> EU Representative (GDPR Art. 27). For users in the European Economic Area, our appointed representative is [REPRESENTATIVE NAME], [REPRESENTATIVE ADDRESS], reachable at [REPRESENTATIVE EMAIL]. The representative may be contacted on any matter relating to the processing of personal data of EEA users.

### Suggested UK representative clause (Privacy — add as §13.1B)

> UK Representative (UK GDPR Art. 27). For users in the United Kingdom, our appointed representative is [REPRESENTATIVE NAME], [REPRESENTATIVE ADDRESS], reachable at [REPRESENTATIVE EMAIL].

### Suggested point-of-sale consent line (add to Pricing.tsx CTA + checkout page)

> By clicking Buy, you agree to the [Terms of Service](/legal/terms), [Privacy Policy](/legal/privacy), [Refund Policy](/legal/refunds), and [Acceptable Use Policy](/legal/acceptable-use), and you confirm you have authority to scan the repository you are submitting.

### Suggested cross-link addition (Terms §3 and §12.4)

> See the [Refund Policy](/legal/refunds) for the full hold-then-charge mechanics, eligibility for refunds, and the dispute / chargeback waiver.

### Suggested DPA-availability clause (Privacy §13.5 — replace placeholder)

> Business customers required by law or internal policy to execute a Data Processing Agreement before deploying the Service may download our standard DPA template at [/legal/dpa] or request a counter-signed copy by emailing hello@gatetest.ai. The standard DPA incorporates GDPR Article 28 obligations, the EU-approved 2021 Standard Contractual Clauses, the UK IDTA / Addendum, the Swiss SCC variant, and a sub-processor list with at least thirty (30) days' advance notice of material sub-processor changes.

### Suggested NZ Privacy Officer designation (Privacy §1 or §17)

> Privacy Officer (NZ Privacy Act 2020 §201). [NAME], reachable at hello@gatetest.ai, is GateTest's designated Privacy Officer for the purposes of the New Zealand Privacy Act 2020. Privacy-related complaints addressed to the Privacy Officer will be acknowledged within five (5) business days.

### Suggested Footer.tsx legal-link block (replacement for lines 47-53)

> ```
> <h4 className="font-semibold text-sm mb-4">Legal</h4>
> <ul className="space-y-2">
>   <li><Link href="/legal/terms" ...>Terms of Service</Link></li>
>   <li><Link href="/legal/privacy" ...>Privacy Policy</Link></li>
>   <li><Link href="/legal/refunds" ...>Refund Policy</Link></li>
>   <li><Link href="/legal/acceptable-use" ...>Acceptable Use</Link></li>
>   <li><a href="mailto:hello@gatetest.ai" ...>Contact</a></li>
> </ul>
> ```

(Move "Privacy" + "Terms" out of the current "Company" column into a dedicated "Legal" column; add Refunds + Acceptable Use.)

---

## Recommended actions before launch

In order of urgency:

1. **Form / register the legal entity, then back-fill across all four docs.** Without this, the indemnity, liability cap, and arbitration clauses identify no recoverable counterparty. Boss Rule item — Craig's decision (sole-trader vs Ltd vs LLC) drives downstream tax / GST / consumer-protection structure.
2. **Get a postal address (PO box minimum)** and fill in Terms §19.6 + §29 + Privacy §1 + every page footer.
3. **Add point-of-sale consent line at checkout** (Pricing.tsx CTA + checkout page) linking to terms / privacy / refunds / acceptable-use. This is the click-wrap-formation evidence the binding-arbitration / class-waiver / chargeback-waiver clauses all depend on.
4. **Add Refunds + Acceptable Use to Footer.tsx and sitemap.ts.** Five minutes of work, removes Severity-1 linkage gaps.
5. **Resolve the email-delivery sub-processor name** (Resend / Postmark / SendGrid — currently TBC in Privacy §11).
6. **Name the EU + UK Article 27 representatives** OR document the exemption you rely on. Cheapest option: third-party EU-Rep service (~€100-300/year, e.g. ePrivacy GmbH, Prighter, EU-Rep.de).
7. **Designate the NZ Privacy Officer** under Privacy Act 2020 §201 (probably Craig himself; document the appointment).
8. **Engage a launch-readiness lawyer** for ~2-4 hours of review focused on the marked DRAFT sections (Terms §13 governing law, §19 arbitration, §9 liability, §10 indemnity, §11 acceptable use, §23 modifications, §24 age, Privacy §1A / §6 / §8 / §9 / §11 / §13 / §12, Refunds §8 chargeback waiver).
9. **Decide on cookie-consent banner posture** (Privacy §7A commits to opt-in for EU/UK/EEA/CH) — either ship an OSS banner (e.g. cookieconsent.com, klaro!js) or document why exempt.
10. **Add `/legal/sub-processors` change-log page** (post-launch polish, but enterprise procurement will ask).
11. **Add `/legal/do-not-sell-or-share` form-page** even though substantively no sale occurs (CCPA form requirement is independent of actual practice).
12. **Add a DPA template at `/legal/dpa`** (post-launch polish — saves response cycles on first EU enterprise inquiry).

None of items 1-9 require code changes outside `website/app/components/Footer.tsx`, `website/app/sitemap.ts`, `website/app/components/Pricing.tsx`, the four `legal/*/page.tsx` files, and a new `/legal/sub-processors/page.tsx` + `/legal/do-not-sell-or-share/page.tsx`. All of them are Boss Rule items (touch public-facing communication / legal posture / money) and require Craig's authorization plus lawyer sign-off before implementation.

---

## What this audit is NOT

- Not legal advice.
- Not a substitute for a launch-readiness lawyer review (~2-4 hours of attorney time on the highlighted DRAFT clauses).
- Not a regulator pre-clearance — the EU DPA, ICO, NZ OPC, and California AG can each take positions that differ from this audit.
- Not exhaustive on multi-state US privacy laws — Virginia, Colorado, Connecticut, Utah, Texas, Oregon, Montana, Tennessee, Indiana, Iowa, Florida, Delaware, New Jersey, New Hampshire, Kentucky, Minnesota, Maryland, Rhode Island, and others all have or are passing comprehensive privacy laws as of 2026. Privacy §13.3 currently lumps them into one paragraph.
