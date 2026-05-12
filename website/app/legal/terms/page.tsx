import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — GateTest",
  description: "GateTest terms of service.",
};

export default function Terms() {
  return (
    <div className="min-h-screen grid-bg px-6 py-24">
      <div className="max-w-3xl mx-auto prose-invert">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-muted mb-8">Effective date: April 9, 2026</p>

        {/* DRAFT — requires attorney review. Governing law and venue (New Zealand / Auckland) inferred from operator location; attorney should confirm choice of law, arbitration framework selection (AAA vs JAMS vs NZIAC), small-claims carve-out scope, and 30-day opt-out mechanics. Age threshold, export-controls reference list, and liability cap floor ($100) also require attorney confirmation for the operator's jurisdiction. The binding-arbitration, class-action waiver, chargeback-waiver, and customer-indemnification clauses are the highest-priority items for attorney review before launch — each of these is jurisdiction-sensitive and their enforceability depends on consumer-protection carve-outs in the operator's and customer's home forums. */}

        <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 mb-6 text-xs text-amber-200/80">
          <strong>Draft notice.</strong> This document is an operator-authored draft intended to
          describe GateTest&apos;s commercial posture prior to attorney review. Several sections
          (including the arbitration, liability-cap, indemnification, and governing-law sections)
          are marked &quot;DRAFT — requires attorney review&quot; and should not be treated as
          final legal terms until that review is complete.
        </div>


        <div className="space-y-6 text-sm text-muted leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. Agreement to Terms</h2>
            <p>
              By accessing or using GateTest (&quot;Service&quot;), including the website at gatetest.ai,
              the GateTest GitHub App, the GateTest CLI tool, and any associated APIs, you
              (&quot;Customer&quot;, &quot;you&quot;, &quot;your&quot;) agree to be bound by these Terms
              of Service (&quot;Terms&quot;). If you do not agree to these Terms, do not use the Service.
            </p>
            <p className="mt-2">
              If you are using the Service on behalf of an organisation, you represent and warrant that
              you have authority to bind that organisation to these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">2. Service Description</h2>
            <p>
              GateTest provides automated code quality scanning and analysis for software repositories.
              The Service includes static code analysis, security pattern detection, accessibility checking,
              performance analysis, and related quality assurance tools. The Service is an automated tool
              and does not constitute professional consulting, security auditing, legal compliance
              certification, or any form of professional advice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">3. Payment Terms</h2>
            <p>
              <strong>3.1 Hold-then-charge model.</strong> When you purchase a scan, a hold (authorisation)
              is placed on your payment method for the full scan amount. The charge is captured only after
              the scan completes and results are delivered. If the scan cannot be completed due to access
              failure, service outage, or technical error on our part, the hold is released and no charge
              is made.
            </p>
            <p className="mt-2">
              <strong>3.2 Currency and processing.</strong> All prices are in US Dollars (USD). Payments
              are processed by Stripe, Inc. We do not store, process, or have access to your full credit
              card number. By providing payment information, you represent that you are authorised to use
              the payment method provided.
            </p>
            <p className="mt-2">
              <strong>3.3 Price changes.</strong> We reserve the right to change pricing at any time.
              Price changes do not affect scans already purchased. Current pricing is displayed on our
              website at the time of purchase and constitutes the binding price for that transaction.
            </p>
            <p className="mt-2">
              <strong>3.4 Taxes.</strong> Prices are exclusive of applicable taxes. You are responsible for
              any sales tax, VAT, GST, or similar taxes applicable in your jurisdiction.
            </p>
            <p className="mt-2">
              <strong>3.5 What &quot;delivery&quot; means.</strong> For the hold-then-charge model, the
              Service is considered <strong>delivered</strong> when a scan completes and a scan report
              is made available to you (via the web UI, email, PR comment, or API response). Delivery
              means that the Service has run the scan modules purchased and produced output. It does
              <strong> NOT</strong> mean (a) that the scan identified any specific number of issues,
              (b) that the scan identified all issues present in your code, (c) that any finding is
              correct or actionable, or (d) that your code is free of defects. Completion and delivery
              of a report is the service rendered; the content of the report is not a warranty.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. Repository Access and Authorisation</h2>
            <p>
              <strong>4.1 Grant of access.</strong> To perform a scan, you grant GateTest temporary,
              limited, read-only access to the specified repository solely for the purpose of performing
              the requested quality analysis. This access terminates immediately upon scan completion.
            </p>
            <p className="mt-2">
              <strong>4.2 Auto-fix access.</strong> For tiers that include auto-fix functionality, you
              additionally grant GateTest permission to create branches and submit pull requests to the
              specified repository. GateTest will never merge pull requests automatically — all merges
              require your explicit approval.
            </p>
            <p className="mt-2">
              <strong>4.3 Authorisation warranty.</strong> You represent and warrant that (a) you own the
              repository or have explicit authorisation from the owner to scan it, (b) scanning the
              repository does not violate any agreement, law, or third-party right, and (c) the repository
              does not contain content that is illegal in your jurisdiction. You agree to indemnify and
              hold harmless GateTest from any claims arising from your breach of this warranty.
            </p>
            <p className="mt-2">
              <strong>4.4 Prohibited use.</strong> You may not use the Service to scan repositories you
              do not own or have permission to scan. You may not use the Service to identify vulnerabilities
              in code for the purpose of exploiting them. You may not use the Service in any manner that
              violates applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. Intellectual Property</h2>
            <p>
              <strong>5.1 Your code.</strong> You retain all ownership and intellectual property rights
              in your source code. GateTest does not claim any ownership of your code. We do not use your
              code for any purpose other than performing the requested scan.
            </p>
            <p className="mt-2">
              <strong>5.2 Scan reports.</strong> Scan reports generated by GateTest are licensed to you
              for your internal use. You may share reports within your organisation. You may not resell
              GateTest reports as a standalone service.
            </p>
            <p className="mt-2">
              <strong>5.3 Our Service.</strong> GateTest, its modules, algorithms, reports, website,
              and all associated intellectual property are owned by GateTest and its operators. These
              Terms do not grant you any rights to our intellectual property beyond the limited right
              to use the Service as described.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">6. Disclaimer of Warranties</h2>
            <p>
              <strong>THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT
              WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING
              WITHOUT LIMITATION WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
              TITLE, AND NON-INFRINGEMENT.</strong>
            </p>
            <p className="mt-2">
              <strong>6.1</strong> GateTest is an automated scanning tool. A passing scan result
              <strong> DOES NOT constitute a guarantee, warranty, certification, or representation
              that your code is free of bugs, security vulnerabilities, compliance issues, or
              defects of any kind.</strong>
            </p>
            <p className="mt-2">
              <strong>6.2</strong> GateTest does not guarantee that it will detect all issues in
              your code. No automated tool can identify every possible defect. The Service is a
              supplement to — not a replacement for — professional code review, manual testing,
              security audits, penetration testing, and compliance assessments.
            </p>
            <p className="mt-2">
              <strong>6.3</strong> We do not warrant that the Service will be uninterrupted,
              timely, secure, or error-free, or that defects will be corrected.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Auto-Fix Disclaimer</h2>
            <p>
              For tiers that include auto-fix functionality, GateTest generates automated code
              modifications and submits them as pull requests. <strong>YOU ARE SOLELY RESPONSIBLE
              FOR REVIEWING, TESTING, AND APPROVING ALL AUTO-FIX CHANGES BEFORE MERGING THEM INTO
              YOUR CODEBASE.</strong> GateTest does not guarantee that auto-fix changes are correct,
              complete, free of side effects, or suitable for your use case. Auto-fix changes may
              introduce new bugs, break existing functionality, or cause data loss. By using auto-fix,
              you accept full responsibility for any consequences of merging auto-generated code changes.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">8. AI Code Review Disclaimer</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The &quot;informational, not professional advice&quot;
              characterisation and the customer-verification obligation should be confirmed by
              counsel in light of any jurisdictions that regulate AI-assisted professional output.]
            </p>
            <p>
              <strong>8.1 Probabilistic output.</strong> The AI-powered code review module uses
              third-party AI services (currently Anthropic Claude) to analyse code. AI analysis is
              probabilistic in nature and may produce false positives (flagging non-issues), false
              negatives (missing real issues), hallucinated references, fabricated line numbers, or
              incorrect suggestions. AI review results are suggestions requiring human verification,
              not definitive assessments.
            </p>
            <p className="mt-2">
              <strong>8.2 Not professional advice.</strong> Scan findings, AI review output, and
              any related explanations are <strong>informational only</strong>. They do not
              constitute legal advice, security auditing, compliance certification, professional
              engineering advice, accounting advice, or any other form of professional advice. You
              are solely responsible for independently verifying any finding before acting on it
              and for obtaining qualified professional advice where appropriate.
            </p>
            <p className="mt-2">
              <strong>8.3 No guarantee of findings.</strong> GateTest does not guarantee that the
              Service will identify every issue in your code, that any issue reported is in fact a
              real issue, that any auto-fix suggestion is correct, or that any severity
              classification is accurate for your context. A passing scan is not a warranty that
              your code is secure, compliant, or fit for any purpose.
            </p>
            <p className="mt-2">
              <strong>8.4 Responsibility for actions taken.</strong> GateTest is not responsible
              for any action (or inaction) you take based on AI review output, scan findings, or
              auto-fix pull requests. You retain sole responsibility for the code you ship.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">9. Limitation of Liability</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. Liability floor ($100), the 12-month look-back, and
              the list of excluded damage categories must be confirmed against the operator&apos;s
              insurance coverage and applicable consumer-protection carve-outs (including the NZ
              Consumer Guarantees Act 1993 where the customer acquires the Service for personal use).]
            </p>
            <p>
              <strong>9.1</strong> TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT
              SHALL GATETEST, ITS OPERATORS, DIRECTORS, EMPLOYEES, AGENTS, CONTRACTORS, OR AFFILIATES
              BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE
              DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, LOST REVENUE, LOST DATA, LOST
              BUSINESS OPPORTUNITIES, BUSINESS INTERRUPTION, LOSS OF GOODWILL, COST OF SUBSTITUTE
              SERVICES, OR OTHER INTANGIBLE LOSSES, ARISING FROM OR RELATED TO YOUR USE OF OR
              INABILITY TO USE THE SERVICE, REGARDLESS OF THE THEORY OF LIABILITY (CONTRACT, TORT
              INCLUDING NEGLIGENCE, STRICT LIABILITY, OR OTHERWISE) AND EVEN IF GATETEST HAS BEEN
              ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. THIS EXCLUSION APPLIES WHETHER THE LOSS
              OR DAMAGE IS DIRECT, INDIRECT, FORESEEABLE, OR UNFORESEEABLE.
            </p>
            <p className="mt-2">
              <strong>9.2</strong> TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, GATETEST&apos;S
              TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS ARISING FROM OR RELATED TO THE SERVICE SHALL
              NOT EXCEED THE GREATER OF (A) ONE HUNDRED US DOLLARS (US$100) OR (B) THE AMOUNT YOU
              ACTUALLY PAID TO GATETEST FOR THE SPECIFIC SCAN OR SERVICE GIVING RISE TO THE CLAIM
              IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM. THIS CAP APPLIES IN THE AGGREGATE TO
              ALL CLAIMS OF EVERY KIND, AND IS NOT RESET BY MULTIPLE CAUSES OF ACTION.
            </p>
            <p className="mt-2">
              <strong>9.3</strong> Without limiting the above, GateTest shall have no liability for:
              (a) any bugs, security breaches, data loss, downtime, or damages occurring in code that
              has been scanned by GateTest, whether the scan passed or failed; (b) any consequences of
              merging auto-fix pull requests; (c) any actions taken or not taken based on scan results
              or AI review output; (d) any third-party claims related to your code or repositories;
              (e) any failure of third-party infrastructure (including Stripe, GitHub, Anthropic,
              Vercel, Cloudflare, or Neon) that is outside our reasonable control; (f) any loss
              arising from use of the CLI tool, which is provided under the MIT License without
              warranty.
            </p>
            <p className="mt-2">
              <strong>9.4 Essential basis of the bargain.</strong> The limitations and exclusions in
              this Section 9 are a material and essential basis of the bargain between you and
              GateTest. The Service would not be offered at its current pricing without these
              limitations. The limitations apply even if a remedy is found to have failed of its
              essential purpose.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">10. Indemnification</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. Mutual-indemnity structure, sole-control-of-defense
              language, and settlement-consent mechanics should be confirmed by counsel.]
            </p>
            <p>
              <strong>10.1 Your indemnity obligation.</strong> You agree to indemnify, defend, and
              hold harmless GateTest and its operators, directors, employees, agents, contractors,
              and affiliates (the &quot;GateTest Parties&quot;) from and against any and all
              third-party claims, demands, damages, losses, liabilities, judgments, settlements,
              costs, and expenses (including reasonable legal fees and expert fees) arising from or
              related to: (a) your use of the Service; (b) your breach of these Terms; (c) your
              violation of any law, regulation, or third-party right (including intellectual
              property, privacy, publicity, or contractual rights); (d) any repository content,
              code, configuration, or data you submit or expose to the Service; (e) any dispute
              between you and a third party related to code scanned by GateTest or to actions you
              took in reliance on scan results, AI review output, or auto-fix pull requests;
              (f) your gross negligence or wilful misconduct; (g) any content you instruct the
              Service to analyse that infringes, defames, or otherwise violates a third party&apos;s
              rights; and (h) any tax liability arising in your jurisdiction.
            </p>
            <p className="mt-2">
              <strong>10.2 Control of defense.</strong> GateTest may, at its election and expense,
              assume the exclusive defense and control of any matter subject to indemnification by
              you. In that event, you will cooperate in good faith with the defense. You may not
              settle any matter without the prior written consent of GateTest if the settlement
              would impose any obligation, admission, or restriction on GateTest.
            </p>
            <p className="mt-2">
              <strong>10.3 Survival.</strong> Your indemnification obligations survive termination
              of these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">11. Acceptable Use and Prohibited Conduct</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. Attorney should align the reverse-engineering
              prohibition with any open-source-license obligations that flow through our
              dependencies and confirm the interoperability-exception language permitted by the
              operator&apos;s jurisdiction.]
            </p>
            <p>You agree not to, and not to permit any third party to:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Scan without authorisation.</strong> Submit for scanning any repository you
                do not own or do not have explicit written permission from the owner to scan; use the
                Service to scan third-party codebases for security research without the target
                owner&apos;s consent
              </li>
              <li>
                <strong>Stress-test or probe.</strong> Use the Service to stress-test, load-test,
                penetration-test, or probe GateTest&apos;s own infrastructure, modules, or API
                rate-limits without prior written permission from GateTest
              </li>
              <li>
                <strong>Inject malicious code.</strong> Submit repositories or content designed to
                attack, compromise, exploit, or exfiltrate data from our scanning infrastructure,
                AI providers, or other customers; submit content containing malware, ransomware,
                backdoors, cryptominers, worms, or any code designed to execute outside the
                documented scan sandbox
              </li>
              <li>
                <strong>Reverse engineer.</strong> Attempt to reverse-engineer, decompile,
                disassemble, translate, or otherwise derive the source code, scanning algorithms,
                module rule-sets, AI prompts, or internal architecture of the Service, except to
                the limited extent expressly permitted by applicable law that cannot be waived by
                contract
              </li>
              <li>
                <strong>Circumvent protections.</strong> Bypass, disable, or interfere with any
                security, authentication, rate-limiting, billing, or access-control mechanism of
                the Service
              </li>
              <li>
                <strong>Exploit pricing.</strong> Submit the same repository repeatedly in a manner
                designed to exploit per-scan pricing, pay-on-completion mechanics, retry logic, or
                hold-then-charge flows
              </li>
              <li>
                <strong>Identify vulnerabilities for exploitation.</strong> Use the Service to
                identify vulnerabilities in third-party code for the purpose of exploiting them,
                selling exploits, or harming other parties
              </li>
              <li>
                <strong>Compete or copy.</strong> Use the Service for competitive intelligence
                gathering against GateTest; use scan output, module descriptions, or report format
                to build a competing service
              </li>
              <li>
                <strong>Scrape or automate.</strong> Interfere with or disrupt the Service or its
                infrastructure; exceed documented usage limits; operate unauthorised bots, spiders,
                or scrapers against our website, API, or app
              </li>
              <li>
                <strong>Resell or sublicense.</strong> Resell, sublicense, white-label, or
                redistribute the Service, its reports, or its output as a standalone service
                without express written permission from GateTest
              </li>
              <li>
                <strong>Violate law.</strong> Use the Service in any manner that violates
                applicable law (including export-control, sanctions, privacy, and intellectual-
                property law) or that facilitates the violation of law by others
              </li>
            </ul>
            <p className="mt-2">
              GateTest reserves the right (but has no obligation) to investigate suspected
              violations, suspend access while investigating, remove submitted content, report
              conduct to law enforcement, and cooperate with legitimate legal process.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">12. Suspension and Termination</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The unilateral-termination-for-any-reason clause,
              the notice periods, and the 30-day data-purge window should be confirmed against any
              consumer-protection rules applicable to the customer&apos;s jurisdiction (including NZ
              CGA, EU consumer-rights directives, and US state laws on subscription cancellation).]
            </p>
            <p>
              <strong>12.1 Unilateral right to suspend or terminate.</strong> GateTest may suspend
              or terminate your access to the Service, in whole or in part, at any time and for any
              reason or no reason, with or without notice, including but not limited to: violation
              of these Terms; suspected abusive behaviour or fraudulent payment activity; a chargeback
              or payment-method dispute; actions that harm or threaten to harm the Service, its
              users, or third parties; a legal, regulatory, or law-enforcement request; our
              reasonable belief that continued access creates risk to GateTest; or our decision to
              discontinue all or part of the Service.
            </p>
            <p className="mt-2">
              <strong>12.2 Notice where practicable.</strong> Where termination is not related to
              abuse, fraud, or legal obligation, we intend to provide at least fourteen (14) days&apos;
              written notice to the email address associated with your account, during which you
              may export your scan reports. Where immediate suspension is necessary to protect the
              Service or other users, we may act without prior notice.
            </p>
            <p className="mt-2">
              <strong>12.3 Effect of termination; data retention and purge.</strong> Upon
              termination, your right to use the Service ceases immediately. Scan reports and
              account metadata will be retained for thirty (30) days post-termination to allow
              export or reactivation, after which they are <strong>permanently purged</strong> from
              our production systems. Backups may persist for a short additional period consistent
              with our backup rotation schedule, and are purged on the normal rotation. Sections 5
              (Intellectual Property), 6 (Disclaimers), 7 (Auto-Fix Disclaimer), 8 (AI Disclaimer),
              9 (Limitation of Liability), 10 (Indemnification), 13 (Governing Law), the arbitration
              and class-waiver sections, and any other clause that by its nature should survive,
              survive termination.
            </p>
            <p className="mt-2">
              <strong>12.4 Your right to terminate.</strong> You may terminate your account at any
              time by contacting us at hello@gatetest.ai or through in-app controls where provided.
              Active Stripe holds will be released and no further charges will be made. Fees paid
              for completed scans are final and non-refundable, except where a non-waivable
              statutory consumer right applies in your jurisdiction.
            </p>
            <p className="mt-2">
              <strong>12.5 No liability for suspension or termination.</strong> Subject to
              applicable law, GateTest shall not be liable to you or any third party for any
              suspension or termination of access to the Service carried out in accordance with
              this Section 12.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">13. Governing Law and Venue</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. Governing law (New Zealand) and venue (Auckland) are
              inferred from the operator&apos;s location. Counsel should confirm the choice of law
              interacts cleanly with Section 19 (Binding Arbitration) — in particular whether the
              arbitration seat is also Auckland and whether New Zealand courts retain supervisory
              jurisdiction over any arbitration. Counsel should also confirm that NZ CGA carve-outs
              are preserved for consumer customers.]
            </p>
            <p>
              <strong>13.1 Governing law.</strong> These Terms, and any dispute or claim arising from
              or related to them or the Service, are governed by and construed in accordance with the
              laws of New Zealand, without regard to its conflict-of-law principles. The United
              Nations Convention on Contracts for the International Sale of Goods does not apply.
            </p>
            <p className="mt-2">
              <strong>13.2 Venue.</strong> Subject to Section 19 (Binding Arbitration), any dispute
              that is not subject to arbitration shall be brought exclusively in the courts located
              in Auckland, New Zealand, and you consent to the personal jurisdiction of those courts.
            </p>
            <p className="mt-2">
              <strong>13.3 Consumer rights preserved.</strong> Nothing in these Terms excludes or
              limits any consumer rights that cannot be excluded or limited under New Zealand law,
              including the Consumer Guarantees Act 1993 and the Fair Trading Act 1986 where
              applicable. To the extent you are a consumer in a jurisdiction whose laws provide
              non-waivable consumer protections, those protections apply notwithstanding any
              contrary language in these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">14. GitHub App</h2>
            <p>
              Installation of the GateTest GitHub App constitutes acceptance of these Terms. The App
              receives webhook events (push, pull request) and reads repository contents solely for
              automated scanning. You can revoke access at any time by uninstalling the App from your
              GitHub account or organisation settings. Uninstallation terminates our access immediately.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">15. Free CLI Tool</h2>
            <p>
              The GateTest CLI tool is provided free of charge under the MIT License and is provided
              &quot;AS IS&quot; without warranty of any kind, express or implied. The full MIT License
              terms apply. Use of the CLI tool is entirely at your own risk.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">16. Service Availability</h2>
            <p>
              <strong>16.1</strong> We target 99.5% uptime for the GateTest web service, measured monthly,
              excluding scheduled maintenance. This is a target, not a guarantee. We do not offer service
              credits or compensation for downtime.
            </p>
            <p className="mt-2">
              <strong>16.2</strong> Scheduled maintenance will be announced at least 24 hours in advance
              where practicable. Emergency maintenance may occur without notice.
            </p>
            <p className="mt-2">
              <strong>16.3</strong> If the Service is unavailable during a scan, the payment hold is
              automatically released and no charge is made. You may retry the scan at no additional cost.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">17. Usage Limits</h2>
            <p>
              <strong>17.1</strong> Per-scan limits: individual repositories up to 500MB in size,
              up to 50,000 files. Repositories exceeding these limits may result in incomplete scans.
            </p>
            <p className="mt-2">
              <strong>17.2</strong> Rate limits: maximum 10 concurrent scans per account, maximum
              100 scans per 24-hour period. If you require higher limits, contact us.
            </p>
            <p className="mt-2">
              <strong>17.3</strong> Abuse of the Service (including scanning the same repository
              repeatedly to exploit pricing, submitting repositories designed to attack our infrastructure,
              or using the Service in any automated manner that degrades it for others) may result in
              immediate suspension without notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">18. Payment Failures</h2>
            <p>
              <strong>18.1</strong> If a payment hold cannot be placed (insufficient funds, expired card,
              bank decline), the scan will not proceed. No scan is initiated until a successful hold is confirmed.
            </p>
            <p className="mt-2">
              <strong>18.2</strong> For the Continuous plan ($49/month), if a recurring charge fails, we
              will attempt to charge the payment method up to 3 times over 7 days. If all attempts fail,
              continuous scanning will be paused until payment is resolved. No data is deleted during this period.
            </p>
            <p className="mt-2">
              <strong>18.3</strong> We accept payment by credit and debit card via Stripe. We do not accept
              cryptocurrency, wire transfer, cheque, or other payment methods unless agreed in writing.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">19. Dispute Resolution; Binding Individual Arbitration; Class-Action Waiver</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. PRIORITY FLAG. The choice of arbitration framework
              (AAA Consumer Rules vs JAMS Streamlined vs New Zealand International Arbitration
              Centre (NZIAC) rules), the venue for arbitration, the small-claims carve-out scope,
              the 30-day opt-out mechanics (including the postal address), and the class-action
              waiver must all be confirmed by counsel for enforceability in each customer
              jurisdiction. Class-waiver enforceability is jurisdiction-sensitive (notably in
              California post-<em>McGill</em>, the EU under consumer directives, and Australia). If
              NZ is the seat, attorney should confirm alignment with the Arbitration Act 1996 (NZ)
              and whether an NZ-seated arbitration can still invoke AAA or JAMS rules. Attorney
              should also review whether the opt-out window (30 days) is adequate and whether any
              jurisdiction requires a longer window.]
            </p>
            <p>
              <strong>19.1 Informal resolution first.</strong> Before initiating any formal dispute
              process, you agree to contact us at hello@gatetest.ai with a written description of
              your concern, your account details, and the outcome you are seeking. We intend to
              acknowledge within three (3) business days and respond substantively within ten (10)
              business days. Both parties agree to attempt in good faith to resolve the dispute
              through direct negotiation for a period of at least thirty (30) days before
              proceeding further.
            </p>
            <p className="mt-2">
              <strong>19.2 Agreement to arbitrate.</strong> If informal resolution does not resolve
              the dispute, then, except for the carve-outs in Section 19.5, <strong>you and GateTest
              agree that any dispute, claim, or controversy arising out of or relating to these
              Terms or the Service shall be resolved by binding individual arbitration</strong>,
              and not in court, by jury, or as part of any class, collective, consolidated, or
              representative action. This agreement to arbitrate is intended to be broadly
              interpreted and includes claims in contract, tort, statute, fraud, misrepresentation,
              or any other legal theory.
            </p>
            <p className="mt-2">
              <strong>19.3 Arbitration rules and administrator.</strong> The arbitration will be
              administered by a neutral administrator mutually selected by the parties. Absent
              agreement, the arbitration will be administered (i) for customers resident in the
              United States, by the American Arbitration Association (AAA) under its Consumer
              Arbitration Rules, with the small-claims-court carve-out in Section 19.5 preserved;
              (ii) for customers resident outside the United States, by the New Zealand
              International Arbitration Centre (NZIAC) under its Arbitration Rules, or, at the
              election of the parties, by JAMS under its Streamlined Arbitration Rules. The seat of
              arbitration is Auckland, New Zealand unless the parties agree otherwise. The
              arbitration may proceed on documents only unless either party requests an in-person
              or virtual hearing.
            </p>
            <p className="mt-2">
              <strong>19.4 Class-action and jury waiver.</strong> YOU AND GATETEST AGREE THAT EACH
              MAY BRING CLAIMS AGAINST THE OTHER ONLY IN AN INDIVIDUAL CAPACITY AND NOT AS A
              PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE, CONSOLIDATED, MASS, OR
              REPRESENTATIVE PROCEEDING. The arbitrator may not consolidate more than one
              person&apos;s claims and may not preside over any form of representative or class
              proceeding. If a court determines that this class-waiver is unenforceable as to a
              particular claim, then that claim (and only that claim) shall be severed from the
              arbitration and may proceed in court; the remaining claims will continue in
              arbitration. TO THE FULLEST EXTENT PERMITTED BY LAW, EACH PARTY WAIVES ANY RIGHT TO A
              JURY TRIAL.
            </p>
            <p className="mt-2">
              <strong>19.5 Small-claims and injunctive carve-outs.</strong> Either party may bring
              an individual action in a small-claims court of competent jurisdiction for disputes
              that qualify under that court&apos;s rules. Either party may seek temporary
              injunctive or equitable relief in a court of competent jurisdiction to protect
              intellectual-property rights, confidential information, or to enforce the prohibited-
              use provisions of Section 11, without breaching this Section 19.
            </p>
            <p className="mt-2">
              <strong>19.6 Thirty-day opt-out.</strong> You have the right to opt out of this
              Section 19 (Binding Individual Arbitration and Class-Action Waiver) by sending a
              signed written opt-out notice, postmarked within thirty (30) days of the date you
              first accepted these Terms, to: GateTest — Arbitration Opt-Out, c/o hello@gatetest.ai
              (postal address to be confirmed in final Terms), OR by emailing
              hello@gatetest.ai with the subject line &quot;Arbitration Opt-Out&quot;, your full
              name, your email address on file, and a clear statement that you are opting out.
              Opting out does not affect any other provision of these Terms and does not deprive
              you of access to the Service. If you opt out, disputes will be resolved exclusively
              in the courts identified in Section 13.2.
            </p>
            <p className="mt-2">
              <strong>19.7 Delegation.</strong> The arbitrator (not a court) has exclusive authority
              to resolve any dispute about the interpretation, applicability, enforceability, or
              formation of this Section 19, except that a court may decide whether the class-action
              waiver in Section 19.4 is enforceable.
            </p>
            <p className="mt-2">
              <strong>19.8 Fees and costs.</strong> Each party bears its own fees and costs unless
              the applicable arbitration rules or applicable law provide otherwise; the arbitrator
              may award costs and reasonable attorneys&apos; fees to the prevailing party where
              permitted.
            </p>
            <p className="mt-2">
              <strong>19.9 Confidentiality of arbitration.</strong> The existence and content of
              the arbitration, including all submissions, evidence, and awards, shall be kept
              confidential by both parties except as necessary to enforce an award or as required
              by law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">20. Export Controls and Sanctions Compliance</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. Counsel should confirm the specific export-control
              regimes that apply to the Service given its use of AI processing and US-based
              sub-processors (Stripe, Anthropic, Vercel, Cloudflare), and should confirm the
              sanctioned-jurisdiction list is current.]
            </p>
            <p>
              <strong>20.1 Sanctions.</strong> You may not access or use the Service if you are, or
              are acting on behalf of anyone who is: (a) located in, organised under the laws of, or
              ordinarily resident in any country or region subject to comprehensive trade sanctions
              by the United States (including countries identified by the US Office of Foreign
              Assets Control (OFAC) — currently including Cuba, Iran, North Korea, Syria, and the
              Crimea, so-called Donetsk People&apos;s Republic, and so-called Luhansk People&apos;s
              Republic regions of Ukraine), the United Kingdom, the European Union, the United
              Nations, Australia, or New Zealand; or (b) identified on the OFAC Specially Designated
              Nationals and Blocked Persons (SDN) List, the US Department of Commerce Denied Persons
              List or Entity List, the UK Consolidated List of financial sanctions targets, the EU
              Consolidated List of persons, groups and entities subject to EU financial sanctions,
              or any equivalent list of another applicable jurisdiction.
            </p>
            <p className="mt-2">
              <strong>20.2 Export-control representations.</strong> You represent and warrant that
              you will not export, re-export, transfer, or make available the Service, any reports,
              or any related technical data to any person, entity, or destination prohibited by the
              export-control or sanctions laws of the United States, the European Union, the United
              Kingdom, Australia, New Zealand, or any other applicable jurisdiction. You are
              responsible for determining and complying with all export-control and sanctions
              obligations in your jurisdiction.
            </p>
            <p className="mt-2">
              <strong>20.3 Screening.</strong> GateTest may, at any time, decline to provide or
              terminate the Service to any user reasonably believed to be subject to sanctions or
              export restrictions, without liability.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">21. Severability</h2>
            <p>
              If any provision of these Terms is held to be unenforceable, invalid, or illegal by a
              court or arbitrator of competent jurisdiction, that provision shall be modified to the
              minimum extent necessary to make it enforceable, or, if that is not possible, severed
              from these Terms. The remaining provisions shall continue in full force and effect.
              The severance of any provision shall not affect the validity or enforceability of the
              remaining provisions, nor the validity of that provision in any other jurisdiction,
              except as expressly stated in Section 19.4 (class-waiver blue-pencil).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">22. Entire Agreement</h2>
            <p>
              These Terms, together with the Privacy Policy and any tier-specific or enterprise
              addenda expressly incorporated by reference,
              constitute the entire agreement between you and GateTest regarding the Service and
              supersede all prior or contemporaneous agreements, proposals, representations, or
              communications, whether oral or written, regarding the subject matter. In the event
              of a conflict between these Terms and any other policy, these Terms control unless
              the other policy expressly states otherwise. No oral or written statement by any
              GateTest representative modifies these Terms unless confirmed in a writing signed by
              an authorised officer of GateTest.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">23. Modifications</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The thirty-day notice period and the
              continued-use-equals-consent model should be confirmed against any jurisdiction
              that requires affirmative opt-in for material changes (notably some EU consumer-
              protection regimes).]
            </p>
            <p>
              <strong>23.1 Right to modify.</strong> We reserve the right to modify these Terms at
              any time.
            </p>
            <p className="mt-2">
              <strong>23.2 Notice of material changes.</strong> Where changes are material, we
              intend to provide at least thirty (30) days&apos; advance notice via email to the
              address associated with your account, via a prominent banner or in-app notice on the
              Service, or both. The &quot;Effective date&quot; at the top of these Terms will be
              updated to reflect the date the modified Terms take effect.
            </p>
            <p className="mt-2">
              <strong>23.3 Continued use equals consent.</strong> Your continued use of the Service
              after the effective date of modified Terms constitutes your acceptance of those Terms.
              If you do not agree to the modified Terms, your sole remedy is to stop using the
              Service and to terminate your account before the effective date; any pre-paid fees
              for unused Service will be refunded pro rata only where required by non-waivable
              applicable law.
            </p>
            <p className="mt-2">
              <strong>23.4 Non-material changes.</strong> Changes that do not materially reduce
              your rights or materially increase your obligations (including corrections of
              typographical errors, clarifications, or updates to contact details) may take effect
              without advance notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">24. Age Requirement</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review. The age threshold (18+ with a 13+ parental-consent
              fallback) should be confirmed against each relevant jurisdiction&apos;s age of contract
              and online-services rules (COPPA in the US, the GDPR &quot;Article 8&quot; age
              threshold in the EU, and the NZ Privacy Act 2020 age rules).]
            </p>
            <p>
              <strong>24.1 Adult use.</strong> The Service is offered to, and may only be used by,
              individuals who are at least eighteen (18) years of age or the age of legal majority
              in their jurisdiction, whichever is greater. By using the Service, you represent and
              warrant that you meet this age requirement and have the legal capacity to enter into
              these Terms.
            </p>
            <p className="mt-2">
              <strong>24.2 Minors.</strong> We do not knowingly permit use of the Service by
              individuals under the age of eighteen (18). Where local law permits a younger user
              (for example, thirteen (13) or older with verifiable parental or guardian consent in
              the United States, or sixteen (16) or older in the EU under Article 8 GDPR), such use
              is only permitted with the verifiable consent of a parent or legal guardian who
              agrees to these Terms on the minor&apos;s behalf. We do not knowingly collect
              personal information from children under thirteen (13) in contravention of COPPA or
              from children under the applicable GDPR Article 8 age. If we become aware that a
              minor has used the Service without appropriate consent, we will terminate the account
              and delete the associated data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">25. Force Majeure</h2>
            <p className="text-xs italic text-muted mb-2">
              [DRAFT — requires attorney review.]
            </p>
            <p>
              GateTest is not liable for any delay, failure to perform, or interruption of the
              Service caused by events or circumstances beyond its reasonable control, including
              but not limited to: acts of God; natural disasters (earthquake, flood, fire,
              volcanic eruption); war, invasion, armed conflict, terrorism, civil unrest, or
              insurrection; cyberattacks, distributed-denial-of-service attacks, or malware
              outbreaks affecting us or our sub-processors; failures or disruptions of
              telecommunications, internet backbone, DNS, or certificate-authority infrastructure;
              failures or outages of upstream providers (including Stripe, GitHub, Anthropic,
              Vercel, Cloudflare, or Neon); government action, embargo, sanction, export
              restriction, or change in law; labour disputes, strikes, or work stoppages; power
              failures; pandemic, epidemic, or public-health emergency; or any other event of the
              nature commonly described as force majeure. Where a force majeure event prevents
              completion of a scan, any Stripe hold is released without capture.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">26. Assignment</h2>
            <p>
              You may not assign or transfer these Terms, or any rights or obligations under them,
              without our prior written consent; any attempted assignment in breach of this Section
              is void. GateTest may assign these Terms without restriction, including in connection
              with a merger, acquisition, corporate reorganisation, sale of assets, or change of
              control, on notice to you.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">27. Notices; Electronic Communications</h2>
            <p>
              You consent to receive notices electronically at the email address associated with
              your account and via banners, in-app messages, or similar prominent notices on the
              Service. Electronic notices satisfy any legal requirement that a notice be in
              writing. Notices to GateTest must be sent to hello@gatetest.ai and are effective on
              acknowledgement of receipt.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">28. No Waiver; No Third-Party Beneficiaries</h2>
            <p>
              A failure or delay by either party to enforce any provision of these Terms is not a
              waiver of that provision or of any future right to enforce it. A waiver is effective
              only if given in writing and signed by the waiving party. These Terms do not create
              any third-party beneficiary rights, except that the limitations of liability,
              disclaimers, and indemnities in favour of GateTest extend to the GateTest Parties
              identified in Section 10.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">29. Contact</h2>
            <p>
              For questions about these Terms, contact us at{" "}
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
