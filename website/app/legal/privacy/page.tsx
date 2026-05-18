import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — GateTest",
  description: "GateTest privacy policy.",
};

export default function Privacy() {
  return (
    <div className="min-h-screen grid-bg px-6 py-24">
      <div className="max-w-3xl mx-auto prose-invert">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted mb-8">Effective date: April 9, 2026</p>

        {/* DRAFT — requires attorney review. Priority review items: (1) Controller-vs-processor
        characterisation for each data category (Article 4 GDPR); (2) legal-basis mapping for EU
        transfers (currently relying on Standard Contractual Clauses via sub-processors); (3) the
        complete sub-processor list and the DPAs governing each; (4) the 72-hour breach window vs
        statutory US state requirements; (5) COPPA and GDPR Art. 8 age-threshold alignment; (6)
        cookie-consent default (currently strictly necessary only) against EU/UK ePrivacy. */}

        <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 mb-6 text-xs text-amber-200/80">
          <strong>Draft notice.</strong> This Privacy Policy is an operator-authored draft intended
          to describe GateTest&apos;s data-handling posture prior to attorney review. Several
          sections (in particular the GDPR, CCPA, sub-processor, and data-transfer sections) are
          marked &quot;DRAFT — requires attorney review&quot; and should not be treated as final
          until that review is complete.
        </div>

        <div className="space-y-6 text-sm text-muted leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. Who We Are</h2>
            <p>
              GateTest (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) operates the website
              gatetest.ai and provides automated code quality scanning services. This Privacy
              Policy explains what personal data we collect, how we use it, how we protect it, and
              your rights regarding your data. It applies to all users of our website, GitHub App,
              CLI tool, and paid scanning services.
            </p>
            <p className="mt-2">
              <strong>Contact for privacy matters.</strong> For any question, complaint, or
              request relating to this Policy or your personal data, contact us at{" "}
              <a href="mailto:hello@gatetest.ai" className="text-accent-light hover:underline">
                hello@gatetest.ai
              </a>.
              We intend to respond substantively within thirty (30) days, and sooner where required
              by applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">1A. Controller vs Processor Roles</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. Controller / processor characterisation must be
              confirmed for each data category and each customer context. Where a business customer
              uploads repositories that contain personal data of its own end users, GateTest is
              typically a processor and the customer is the controller; a Data Processing Addendum
              (DPA) should govern.]
            </p>
            <p>
              For the purposes of the EU / UK GDPR and analogous laws, GateTest acts as:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Controller</strong> for personal data that you give us directly to run our
                business — for example, your account email address, the repository URLs you submit,
                your payment metadata (receipts, the last four digits of a card, the billing
                country), and web-server logs.
              </li>
              <li>
                <strong>Processor</strong> for personal data that may be contained in code, commits,
                issues, or other repository content submitted to the Service — including any
                personal data of your users, employees, or third parties that may appear in source
                files, configuration, comments, or logs you expose to the Service. You remain the
                controller of that data. If you require a formal Data Processing Agreement (DPA) or
                Standard Contractual Clauses (SCCs) to govern that processing, contact us.
              </li>
              <li>
                <strong>Joint-controller or independent-controller</strong> relationships with our
                sub-processors (for example, Stripe for payment processing, where Stripe is an
                independent controller for fraud-prevention and regulatory purposes).
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">2. Data We Collect</h2>

            <h3 className="text-sm font-semibold text-foreground mt-3 mb-1">2.1 Account and Payment Data</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Email address (for scan delivery, receipts, and communication)</li>
              <li>Payment information (processed entirely by Stripe — we never see, store, or have access to your full card number, CVV, or billing address)</li>
              <li>GitHub username and organisation name (when installing the GitHub App)</li>
              <li>Repository URLs submitted for scanning</li>
            </ul>

            <h3 className="text-sm font-semibold text-foreground mt-3 mb-1">2.2 Repository Data</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Source code is accessed <strong>temporarily in memory</strong> during the scan process</li>
              <li>Source code is <strong>NOT permanently stored</strong> on our servers, databases, or any persistent storage</li>
              <li>Source code is <strong>NOT copied, cached, backed up, or retained</strong> after the scan completes</li>
              <li>Scan results (pass/fail outcomes, issue descriptions, file paths, line numbers) are stored for report delivery</li>
              <li>Scan results do <strong>NOT contain your actual source code</strong> — only metadata about issues found</li>
            </ul>

            <h3 className="text-sm font-semibold text-foreground mt-3 mb-1">2.3 Website Data</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Standard web server logs (IP address, browser type, referring URL, pages visited, timestamps)</li>
              <li>We do <strong>NOT</strong> use third-party tracking cookies</li>
              <li>We do <strong>NOT</strong> use advertising pixels or retargeting</li>
              <li>We do <strong>NOT</strong> use Google Analytics or similar tracking services</li>
              <li>We do <strong>NOT</strong> sell, rent, or trade any user data to third parties</li>
            </ul>

            <h3 className="text-sm font-semibold text-foreground mt-3 mb-1">2.4 Distilled Fix Recipes (Cross-Customer Learning)</h3>
            <p>
              To improve our deterministic fix engine over time, GateTest may store small,
              anonymised snippets of code patterns that our AI successfully repaired (typically
              1&ndash;3 KB per pattern). Before storage these snippets are stripped of identifiers,
              project names, file paths, and other potentially identifying values, and reduced to
              a generic before/after transformation. The resulting snippets become deterministic
              rules in our fix engine that benefit all customers &mdash; your scan&apos;s fixes
              become faster and cheaper to produce, and so do everyone else&apos;s.
            </p>
            <p className="mt-2">
              <strong>Opt-out:</strong> you can disable distillation for your runs by setting the
              environment variable <code>GATETEST_DISTILL_OPT_OUT=1</code> in your CI environment
              (or in the request body when calling our APIs directly). When this flag is set, no
              snippets from your runs are stored, and the corresponding patterns do not feed back
              into the shared fix-recipe store.
            </p>
            <p className="mt-2">
              We do <strong>NOT</strong> store distilled snippets that retain customer identifiers,
              repository URLs, customer-named symbols, secrets, or any data that could be used to
              re-identify a specific customer or codebase. We do <strong>NOT</strong> resell the
              recipe store as a standalone product, license it to third parties, or use it for any
              purpose other than improving the fix engine for paying customers of GateTest.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">3. How We Use Your Data</h2>
            <p>We use your data strictly for the following purposes:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>Performing the code scan you requested and paid for</li>
              <li>Delivering scan reports and auto-fix pull requests</li>
              <li>Processing payments via Stripe</li>
              <li>Sending transactional communications (scan status, receipts)</li>
              <li>Responding to support enquiries</li>
              <li>Improving scan accuracy and module quality (using aggregate, anonymised data only)</li>
            </ul>
            <p className="mt-3 font-semibold text-foreground">We absolutely DO NOT:</p>
            <ul className="list-disc pl-5 space-y-1 mt-1">
              <li>Sell, rent, lease, or trade your personal data or code to any third party</li>
              <li>Use your source code for training AI models or machine learning</li>
              <li>Share your code or scan results with other customers</li>
              <li>Use your data for advertising, profiling, or marketing to third parties</li>
              <li>Access your repositories outside the scope of the requested scan</li>
              <li>Retain your source code after the scan is complete</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. AI Code Review Data Handling</h2>
            <p>
              If your scan includes the AI-powered code review module, relevant code snippets from the
              files being reviewed are sent to the Anthropic Claude API for analysis. This data handling
              is governed by the following:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>Anthropic&apos;s API usage policy explicitly prohibits using API inputs for model training</li>
              <li>Code sent for AI review is processed in real-time and is not stored by Anthropic after analysis</li>
              <li>Only files selected for review are sent — not your entire repository</li>
              <li>You may opt out of AI review by selecting a scan tier that does not include it</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. GitHub App Data</h2>
            <p>
              If you install the GateTest GitHub App on your account or organisation:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>We receive webhook events for push and pull request activities on connected repositories</li>
              <li>We receive temporary read access to repository contents for the purpose of scanning</li>
              <li>We do not access repositories that are not connected to the App</li>
              <li>We do not access any repositories after the App is uninstalled</li>
              <li>You can revoke access at any time by uninstalling the App from your GitHub settings</li>
              <li>Uninstallation is immediate and irrevocable — we lose all access instantly</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">6. Data Retention Schedule</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. Retention windows should be confirmed against NZ
              tax law, the Financial Reporting Act 2013, the Privacy Act 2020 storage-limitation
              principle, and counterpart retention-limitation rules under GDPR (Art. 5(1)(e)) and
              CCPA / CPRA. Where scan results are retained &quot;indefinitely while paid account
              active&quot;, counsel should confirm the documented lawful basis and storage-
              limitation justification.]
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong>Source code:</strong> NOT stored. Accessed in memory during the scan
                window, discarded immediately upon scan completion. Zero persistent retention.
              </li>
              <li>
                <strong>Scan results (metadata — findings, file paths, line numbers, severity,
                summary):</strong> retained for thirty (30) days for free-tier scans, and for the
                duration of an active paid account (while the account is in good standing), for
                historical reference, trend analysis, and re-download. On account deletion or
                downgrade below a retaining tier, scan results are purged within thirty (30) days.
              </li>
              <li>
                <strong>AI code-review output:</strong> retained on the same schedule as the
                related scan report. The input snippets sent to the AI provider are not retained
                by us after the response is received.
              </li>
              <li>
                <strong>Session tokens and authentication cookies:</strong> retained for thirty
                (30) days of inactivity, then expired.
              </li>
              <li>
                <strong>Server logs:</strong> retained for thirty (30) days for security, abuse
                detection, and debugging, then deleted on rotation.
              </li>
              <li>
                <strong>Account records (email, GitHub account link, subscription status):</strong>
                retained while your account is active. On deletion, purged from production systems
                within thirty (30) days, with backups rotating out on our normal schedule.
              </li>
              <li>
                <strong>Payment records:</strong> retained as required by New Zealand tax and
                financial-reporting law (currently seven (7) years), and for equivalent statutory
                periods in any other applicable jurisdiction.
              </li>
              <li>
                <strong>Transactional email:</strong> delivery logs retained for thirty (30) days;
                content retained by our email-delivery sub-processor per its retention policy.
              </li>
              <li>
                <strong>Support correspondence:</strong> retained for three (3) years from last
                contact, then deleted.
              </li>
              <li>
                <strong>Deleted-account data:</strong> purged from production systems within
                thirty (30) days of deletion request. Short-lived backups may persist for the
                backup-rotation window and are then deleted.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Data Security</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>All connections to gatetest.ai are encrypted via TLS 1.2+ (HTTPS)</li>
              <li>Payment processing is handled entirely by Stripe (PCI-DSS Level 1 compliant)</li>
              <li>Repository access uses GitHub&apos;s authenticated API with time-limited installation tokens</li>
              <li>Minimal permissions requested — read-only for contents, write only for PR comments and commit statuses</li>
              <li>No source code is written to disk, databases, or persistent storage at any point</li>
              <li>Infrastructure hosted on Vercel with SOC 2 Type II compliance</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">7A. Cookies and Local Storage</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The strictly-necessary-by-default posture, and the
              opt-in model for any non-essential analytics, should be confirmed against EU/UK
              ePrivacy rules and the Privacy and Electronic Communications Regulations.]
            </p>
            <p>
              We use the minimum set of cookies and local-storage items necessary to operate the
              Service. By default, only <strong>strictly necessary</strong> cookies are set:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Session / authentication cookies</strong> — required to keep you logged in
                and to protect against CSRF. Flagged <code>Secure</code>, <code>HttpOnly</code>,
                and <code>SameSite=Lax</code> or <code>Strict</code>.
              </li>
              <li>
                <strong>Checkout state</strong> — a short-lived cookie set by Stripe during the
                checkout session to complete the payment flow.
              </li>
              <li>
                <strong>Consent cookie</strong> — records your cookie-banner preferences where a
                banner is shown.
              </li>
            </ul>
            <p className="mt-2">
              We do not set advertising, retargeting, or cross-site tracking cookies. Any
              non-essential analytics (for example, aggregate page-view telemetry to improve the
              product) will be <strong>opt-in</strong> and will not run unless you have given
              explicit consent in regions that require it (EU, UK, EEA, Switzerland).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">8. Your Rights</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The timeline commitments and verification process
              should be confirmed against the Privacy Act 2020 (NZ), GDPR Articles 12-23, UK GDPR,
              and CCPA/CPRA response windows.]
            </p>
            <p>
              Regardless of your location, you have the following rights regarding your personal
              data. Some of these rights are absolute; others are subject to conditions and
              exemptions under applicable law.
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Right to access:</strong> request confirmation of whether we hold personal
                data about you, and a copy of that data.
              </li>
              <li>
                <strong>Right to rectification:</strong> request correction of inaccurate or
                incomplete data.
              </li>
              <li>
                <strong>Right to erasure (&quot;right to be forgotten&quot;):</strong> request
                permanent deletion of your data. We will delete within thirty (30) days unless
                retention is required to meet a legal obligation (for example, tax records), to
                establish, exercise, or defend a legal claim, or for other lawful grounds
                recognised by applicable law.
              </li>
              <li>
                <strong>Right to portability:</strong> request your data in a structured,
                commonly-used, machine-readable format.
              </li>
              <li>
                <strong>Right to restrict processing:</strong> request that we stop certain
                processing while a dispute is resolved.
              </li>
              <li>
                <strong>Right to object:</strong> object to processing based on legitimate
                interests or direct marketing.
              </li>
              <li>
                <strong>Right to withdraw consent:</strong> where we rely on your consent, you may
                withdraw it at any time without affecting the lawfulness of prior processing.
              </li>
              <li>
                <strong>Right not to be subject to solely automated decisions:</strong> scan
                results are informational tools, not automated decisions with legal effect.
              </li>
              <li>
                <strong>Right to lodge a complaint:</strong> complain to your local data-protection
                authority (see Section 13).
              </li>
            </ul>
            <p className="mt-2">
              <strong>How to exercise a right.</strong> Email{" "}
              <a href="mailto:hello@gatetest.ai" className="text-accent-light hover:underline">
                hello@gatetest.ai
              </a>{" "}
              with a clear description of the right you wish to exercise and the account email
              or identifier we should use to locate your data. We may ask for reasonable
              information to verify your identity before acting on a request, to protect you
              against unauthorised access.
            </p>
            <p className="mt-2">
              <strong>Response timeline.</strong> We intend to acknowledge your request within
              five (5) business days and respond substantively within thirty (30) days, or within
              the shorter period required by applicable law (including twenty (20) working days
              under the New Zealand Privacy Act 2020, one (1) month under GDPR Art. 12(3), and
              forty-five (45) days under the CCPA / CPRA, in each case extendable only where
              permitted by the applicable law). Requests are handled without charge except where
              they are manifestly unfounded, excessive, or repetitive, in which case a reasonable
              fee may apply or we may refuse the request, as permitted by applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">9. International Data Transfers and Safeguards</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. Counsel should confirm that the listed transfer
              mechanisms (SCCs, adequacy decisions) are each in effect with the relevant
              sub-processor at launch, and should assess whether supplementary measures under
              <em> Schrems II</em> are required for any US-bound transfer.]
            </p>
            <p>
              Because our infrastructure providers and sub-processors operate in the United States
              (and, in some cases, the European Union, United Kingdom, and other jurisdictions),
              your personal data may be transferred to, stored in, and processed in countries
              outside your home jurisdiction. Those countries may not have data-protection laws
              considered equivalent to those in your country.
            </p>
            <p className="mt-2">
              <strong>Transfer mechanisms we rely on:</strong>
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>EU / UK / Swiss transfers:</strong> the European Commission&apos;s
                Standard Contractual Clauses (SCCs) (as updated June 2021), the UK International
                Data Transfer Agreement (IDTA) or UK Addendum to the SCCs, and the Swiss Federal
                Data Protection and Information Commissioner&apos;s approved clauses, each as
                implemented in sub-processor DPAs.
              </li>
              <li>
                <strong>Adequacy decisions:</strong> where the destination country benefits from
                an adequacy decision issued by the European Commission or the UK Secretary of
                State (including the EU-US and UK-US Data Privacy Frameworks for certified
                recipients), we rely on that decision as the transfer basis.
              </li>
              <li>
                <strong>New Zealand transfers:</strong> where applicable, we rely on the transfer
                mechanisms permitted under Part 1B of the New Zealand Privacy Act 2020, including
                comparable-safeguards agreements with sub-processors.
              </li>
              <li>
                <strong>Other jurisdictions:</strong> we apply equivalent contractual and
                organisational safeguards, and perform a transfer-impact assessment where
                applicable law requires one.
              </li>
            </ul>
            <p className="mt-2">
              You may request a copy of the transfer mechanism we rely on for your data by
              emailing hello@gatetest.ai.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">10. Children&apos;s Privacy (COPPA and GDPR Article 8)</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The COPPA threshold (13) and GDPR Article 8 Member
              State age (13-16) must be confirmed for each applicable jurisdiction.]
            </p>
            <p>
              The Service is not directed at children and is intended for users aged eighteen (18)
              or older (see Terms of Service, Section 24). We do not knowingly collect personal
              data from:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                Children under thirteen (13) in the United States (in accordance with the
                Children&apos;s Online Privacy Protection Act, <strong>COPPA</strong>).
              </li>
              <li>
                Children under sixteen (16) in the European Economic Area, Iceland, Liechtenstein,
                and Norway, or under the applicable Member State age threshold (which may be as
                low as thirteen (13) in some Member States) pursuant to Article 8 of the GDPR,
                without verifiable parental or guardian consent.
              </li>
              <li>
                Children under the applicable age threshold in any other jurisdiction (for example,
                under the UK Age Appropriate Design Code).
              </li>
            </ul>
            <p className="mt-2">
              If we become aware that we have inadvertently collected personal data from a child
              below the applicable threshold without verifiable parental or guardian consent, we
              will delete that data as soon as reasonably practicable. A parent or guardian who
              believes a child has provided data to us should contact hello@gatetest.ai.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">11. Sub-Processors and Third-Party Services</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The sub-processor list and the DPA references
              below must be confirmed current at launch. For each sub-processor, counsel should
              confirm (i) the DPA or equivalent in force, (ii) the lawful transfer mechanism for EU
              / UK data (typically SCCs plus supplementary measures or a valid adequacy decision),
              and (iii) the minimum data actually shared.]
            </p>
            <p>
              We rely on the following sub-processors to operate the Service. For each, we list
              what they see, why, and the data-protection framework we rely on. This list is
              updated when sub-processors change; material changes are notified in advance where
              required by applicable law or your DPA.
            </p>
            <ul className="list-disc pl-5 space-y-3 mt-3">
              <li>
                <strong>Stripe, Inc.</strong> (United States / Ireland) — payment processing,
                fraud-prevention, tax calculation.
                <br />
                <em>Sees:</em> payment-method token, card BIN / last four, billing country,
                customer email, amount, currency, GateTest scan metadata (scan ID, tier).
                <br />
                <em>Governed by:</em> Stripe&apos;s Data Processing Addendum and Standard
                Contractual Clauses (SCCs) for EU/UK transfers where applicable.
                <a href="https://stripe.com/privacy" className="text-accent-light hover:underline ml-1" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
              </li>
              <li>
                <strong>GitHub, Inc. (a Microsoft company)</strong> (United States) — repository
                access via the GitHub REST API and GitHub App webhook delivery.
                <br />
                <em>Sees:</em> your GitHub account identifier, organisation identifier, repository
                name, and repository contents at read time (during the scan window).
                <br />
                <em>Governed by:</em> GitHub Customer Terms, GitHub Data Protection Agreement, and
                Microsoft&apos;s EU Data Boundary / SCCs.
                <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" className="text-accent-light hover:underline ml-1" target="_blank" rel="noopener noreferrer">Privacy Statement</a>.
              </li>
              <li>
                <strong>Anthropic, PBC</strong> (United States) — AI code-review processing via the
                Claude API.
                <br />
                <em>Sees:</em> only the specific code snippets sent for review (not your whole
                repository). Anthropic&apos;s commercial API Terms prohibit training on your inputs.
                <br />
                <em>Governed by:</em> Anthropic Commercial Terms of Service and Data Processing
                Addendum with SCCs for EU/UK transfers where applicable.
                <a href="https://www.anthropic.com/privacy" className="text-accent-light hover:underline ml-1" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
              </li>
              <li>
                <strong>Vercel, Inc.</strong> (United States) — website, serverless function
                hosting, edge network, analytics (in aggregate form only where enabled).
                <br />
                <em>Sees:</em> HTTP request metadata (IP, path, user-agent, timestamp), any
                in-memory state during function execution.
                <br />
                <em>Governed by:</em> Vercel Data Processing Addendum with SCCs for EU/UK
                transfers.
                <a href="https://vercel.com/legal/privacy-policy" className="text-accent-light hover:underline ml-1" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
              </li>
              <li>
                <strong>Cloudflare, Inc.</strong> (United States) — DNS, edge network, DDoS
                mitigation, TLS termination (where applicable).
                <br />
                <em>Sees:</em> HTTP request metadata (IP, request headers, TLS handshake data) for
                routing and abuse-mitigation purposes.
                <br />
                <em>Governed by:</em> Cloudflare Data Processing Addendum with SCCs for EU/UK
                transfers.
                <a href="https://www.cloudflare.com/privacypolicy/" className="text-accent-light hover:underline ml-1" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
              </li>
              <li>
                <strong>Neon, Inc.</strong> (United States / EU, region-dependent) — managed
                Postgres database used for scan metadata, scan queue state, and account records.
                <br />
                <em>Sees:</em> account email, scan IDs, scan results metadata (findings, file
                paths, line numbers — not source code), account subscription state.
                <br />
                <em>Governed by:</em> Neon Data Processing Addendum with SCCs for EU/UK transfers
                where applicable.
                <a href="https://neon.tech/privacy-policy" className="text-accent-light hover:underline ml-1" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
              </li>
              <li>
                <strong>Functional Software, Inc. (Sentry)</strong> (United States) — application
                error tracking and performance monitoring for the gatetest.ai website and APIs.
                <br />
                <em>Sees:</em> stack traces of uncaught exceptions and unhandled rejections, HTTP
                request metadata (URL, method, IP, user-agent, response code), browser session
                replay samples (sampled, with form input masking), and release / deployment tags.
                Local-variable values captured at the point of failure are passed through an
                automated scrubber that strips request bodies, prompts, file contents, repository
                URLs, API keys, tokens, secrets, cookies, and authorization headers BEFORE they
                leave the GateTest process. We never intentionally send customer source code,
                Claude prompts, or scan output to Sentry.
                <br />
                <em>Governed by:</em> Sentry Data Processing Addendum and Standard Contractual
                Clauses for EU/UK transfers where applicable.
                <a href="https://sentry.io/privacy/" className="text-accent-light hover:underline ml-1" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
              </li>
              <li>
                <strong>Email delivery provider</strong> — transactional email delivery (scan
                receipts, status, password resets). Provider identity to be confirmed at launch
                (e.g. Resend, Postmark, or SendGrid).
                <br />
                <em>Sees:</em> recipient email address, email subject and body.
                <br />
                <em>Governed by:</em> provider&apos;s Data Processing Addendum with SCCs for EU/UK
                transfers.
              </li>
            </ul>
            <p className="mt-3">
              We do not sell, rent, trade, or otherwise transfer your personal data to any third
              party outside the sub-processors listed above, except: (i) to comply with a valid
              legal obligation, court order, or enforceable government request; (ii) to a successor
              entity in connection with a merger, acquisition, or sale of assets, subject to this
              Privacy Policy; or (iii) with your explicit consent. Each sub-processor receives
              only the minimum data required to perform its function.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">12. Data Breach Notification</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The 72-hour commitment aligns with GDPR Article
              33 and the NZ Privacy Act 2020 &quot;as soon as practicable&quot; standard; counsel
              should confirm the shorter windows required by specific US state breach-notification
              laws (e.g. Florida &lt;30 days, Texas &lt;60 days) and whether a commitment should be
              framed as &quot;statutory timeframe or sooner&quot; to avoid inconsistency.]
            </p>
            <p>
              We maintain an incident-response plan aimed at detecting, containing, and notifying
              affected parties of security incidents involving personal data. In the event of a
              data breach that meets the notification threshold under applicable law, we intend to:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Regulator notification.</strong> Notify the competent supervisory authority
                without undue delay and, where feasible, within <strong>seventy-two (72) hours</strong>
                of becoming aware of the breach, consistent with GDPR Article 33. For New Zealand,
                notify the Office of the Privacy Commissioner in accordance with Part 6 of the
                Privacy Act 2020. For US states, notify within the statutory timeframe for each
                state where affected residents reside.
              </li>
              <li>
                <strong>Affected-user notification.</strong> Notify affected users via email to
                the address associated with the account, as soon as reasonably practicable after
                the scope of the breach is understood, with a description of the nature of the
                breach, the categories of data affected, the likely consequences, and the measures
                taken or proposed.
              </li>
              <li>
                <strong>Cooperation.</strong> Cooperate with your controller obligations where we
                act as your processor (including providing the information you need to meet your
                own notification obligations under your DPA).
              </li>
              <li>
                <strong>Remediation.</strong> Take reasonable steps to contain the breach, remove
                attacker access, rotate compromised credentials, and reduce the likelihood of
                recurrence.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">13. Jurisdiction-Specific Disclosures</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. PRIORITY FLAG. Each sub-section (GDPR Art. 13
              disclosures, UK-GDPR specifics, CCPA / CPRA consumer-rights language, Virginia CDPA,
              Colorado CPA, Connecticut CTDPA, Utah UCPA, NZ Privacy Act 2020) should be reviewed
              by counsel for completeness. The current draft covers GDPR and California but is not
              a full multi-state US compliance pack.]
            </p>
            <p>
              <strong>13.1 European Economic Area, United Kingdom, and Switzerland (GDPR / UK GDPR
              / Swiss FADP).</strong> If you are located in the EEA, UK, or Switzerland, we
              process your personal data on the following lawful bases (Art. 6 GDPR):
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Performance of a contract</strong> (Art. 6(1)(b)) — to provide, bill for,
                and support the Service you purchased.
              </li>
              <li>
                <strong>Legitimate interests</strong> (Art. 6(1)(f)) — to operate and secure the
                Service, prevent fraud and abuse, maintain audit logs, improve scan accuracy in
                aggregate, and defend legal claims. We have assessed our legitimate interests
                against your rights and freedoms.
              </li>
              <li>
                <strong>Consent</strong> (Art. 6(1)(a)) — for any non-essential cookies or
                analytics, and for any marketing communications. You may withdraw consent at any
                time.
              </li>
              <li>
                <strong>Legal obligation</strong> (Art. 6(1)(c)) — to meet tax, accounting,
                regulatory, and lawful-process obligations.
              </li>
            </ul>
            <p className="mt-2">
              <strong>Required Art. 13 disclosures:</strong> the controller is GateTest (contact:
              hello@gatetest.ai); the recipients are the sub-processors listed in Section 11;
              your data may be transferred internationally under the safeguards in Section 9; the
              retention periods are in Section 6; you have the rights in Section 8 plus the right
              to lodge a complaint with a supervisory authority; where we rely on legitimate
              interests, you may request further details and object; the provision of account data
              is required to contract with us, but providing any specific optional data is
              voluntary; we do not use solely automated decision-making with legal or similarly
              significant effect on you.
            </p>
            <p className="mt-2">
              <strong>13.2 California (CCPA / CPRA) — Notice at Collection and Consumer Rights.</strong>
              If you are a California resident, you have the following rights under the California
              Consumer Privacy Act, as amended by the California Privacy Rights Act:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Right to know</strong> the categories and specific pieces of personal
                information we have collected about you, the categories of sources, the business
                or commercial purpose, and the categories of third parties with whom we share it.
              </li>
              <li>
                <strong>Right to delete</strong> your personal information, subject to statutory
                exceptions.
              </li>
              <li>
                <strong>Right to correct</strong> inaccurate personal information.
              </li>
              <li>
                <strong>Right to opt out of sale or sharing</strong> of personal information.
                <strong>We do not sell or share your personal information</strong> as those terms
                are defined in the CCPA / CPRA. We do not offer financial incentives in exchange
                for personal information.
              </li>
              <li>
                <strong>Right to limit use of sensitive personal information.</strong> We do not
                collect or use sensitive personal information for purposes that require providing
                the right to limit under the CCPA / CPRA.
              </li>
              <li>
                <strong>Right to non-discrimination</strong> for exercising your CCPA / CPRA rights.
              </li>
            </ul>
            <p className="mt-2">
              To exercise a CCPA / CPRA right, email hello@gatetest.ai with the subject line
              &quot;CCPA Request&quot;. We will verify your identity before acting. An authorised
              agent may submit a request on your behalf with your signed permission.
            </p>
            <p className="mt-2">
              <strong>13.3 Other US state laws.</strong> Residents of Virginia (VCDPA), Colorado
              (CPA), Connecticut (CTDPA), Utah (UCPA), and other US states with comprehensive
              privacy laws have rights substantially similar to those described for California
              above (right to access, correct, delete, opt out of targeted advertising and sale).
              We do not engage in targeted advertising or the sale of personal information as
              defined in these laws. To exercise a right, email hello@gatetest.ai.
            </p>
            <p className="mt-2">
              <strong>13.4 New Zealand (Privacy Act 2020).</strong> If you are in New Zealand, this
              Privacy Policy operates alongside the Information Privacy Principles of the Privacy
              Act 2020. You may complain to the Office of the Privacy Commissioner
              (privacy.org.nz) if you believe we have not handled your data in accordance with
              the Act.
            </p>
            <p className="mt-2">
              <strong>13.5 Data Processing Agreement (DPA).</strong> Business customers who
              require a formal Data Processing Agreement, a Data Protection Addendum, Standard
              Contractual Clauses, or a sub-processor disclosure may request one by contacting
              hello@gatetest.ai. Where we act as processor for your end-user personal data, we
              intend to offer a DPA incorporating GDPR Article 28 obligations and the EU-approved
              SCCs.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">14. Data Security</h2>
            <p>
              All data in transit is encrypted using TLS 1.2 or higher. Scan reports stored in our
              database are encrypted at rest. Payment information is handled exclusively by Stripe and
              never touches our servers. Source code is processed in-memory and is not written to
              persistent storage. We conduct periodic security reviews of our infrastructure and
              follow the principle of least privilege for all system access.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">15. Governing Law</h2>
            <p>
              This Privacy Policy is governed by the laws of New Zealand, including the Privacy Act 2020.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">16. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. For material changes — for
              example, a new category of data collection, a new sub-processor handling personal
              data, a change to retention periods, or a change that expands the ways we use your
              data — we intend to provide at least <strong>thirty (30) days&apos;</strong> advance
              notice via email to the address associated with your account, via a prominent banner
              or in-app notice on the Service, or both. Non-material changes (such as
              clarifications, formatting, or updates to contact details) may take effect without
              advance notice. The &quot;Effective date&quot; at the top of this page indicates the
              latest revision. Your continued use of the Service after the effective date of
              material changes constitutes your acceptance, subject to any opt-out right or
              additional consent required by applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">17. Contact</h2>
            <p>
              For privacy questions, data requests, or concerns, contact us at{" "}
              <a href="mailto:hello@gatetest.ai" className="text-accent-light hover:underline">
                hello@gatetest.ai
              </a>.
            </p>
          </section>
        </div>

        <div className="mt-12">
          <Link href="/" className="text-sm text-muted hover:text-foreground transition-colors">
            &larr; Back to gatetest.ai
          </Link>
        </div>
      </div>
    </div>
  );
}
