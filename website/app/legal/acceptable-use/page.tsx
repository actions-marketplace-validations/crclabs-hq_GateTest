import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Acceptable Use Policy — GateTest",
  description: "GateTest acceptable use policy — what you may and may not do with the service.",
};

export default function AcceptableUse() {
  return (
    <div className="min-h-screen grid-bg px-6 py-24">
      <div className="max-w-3xl mx-auto prose-invert">
        <h1 className="text-3xl font-bold mb-2">Acceptable Use Policy</h1>
        <p className="text-sm text-muted mb-8">Effective date: April 9, 2026</p>

        {/* Attorney review: standard AUP for a B2B SaaS; no unusual provisions. Verify
        that Section 7 (AI output) aligns with final Terms of Service Section 7 wording. */}

        <div className="space-y-6 text-sm text-muted leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. Purpose</h2>
            <p>
              This Acceptable Use Policy (&quot;AUP&quot;) governs your use of the GateTest
              platform, CLI tool, API, GitHub App, and all associated services
              (collectively, the &quot;Service&quot;) operated by GateTest (&quot;we,&quot;
              &quot;us,&quot; &quot;our&quot;). This AUP is incorporated by reference into the
              GateTest{" "}
              <Link href="/legal/terms" className="text-accent-light hover:underline">
                Terms of Service
              </Link>
              . Capitalised terms not defined here have the meaning given in the Terms of Service.
            </p>
            <p className="mt-2">
              We built GateTest to help developers write safer, higher-quality code. This policy
              exists to protect our infrastructure, other customers, and third parties from
              misuse. It is written to be clear, not to be long.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">2. Authorised Use</h2>
            <p>You may use the Service to:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>Scan repositories that you own or that you have explicit written permission from the repository owner to scan.</li>
              <li>Run the CLI tool against codebases on machines you own or control.</li>
              <li>Integrate the GitHub App with repositories in GitHub organisations where you are an administrator or have been granted permission to install third-party apps.</li>
              <li>Use the API with valid credentials to automate scans within your authorised quota.</li>
              <li>Review scan findings, auto-fix pull requests, and reports for the legitimate purposes of code quality improvement, security hardening, and compliance.</li>
              <li>Demonstrate the Service to prospective customers using repositories you own or control.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">3. Prohibited Uses</h2>
            <p>You may <strong>not</strong> use the Service to:</p>

            <h3 className="text-base font-semibold text-foreground mt-4 mb-2">3.1 Unauthorised Access and Scanning</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Scan any repository, codebase, or system that you do not own or do not have explicit written permission to scan.</li>
              <li>Use the Service as a reconnaissance or intelligence-gathering tool against organisations, systems, or individuals you are not authorised to assess.</li>
              <li>Attempt to access or exfiltrate code, secrets, tokens, or other data from repositories you are not authorised to access.</li>
              <li>Use scan results, findings, or vulnerability reports to attack, exploit, or harm the owners of the scanned repository or any third party.</li>
            </ul>

            <h3 className="text-base font-semibold text-foreground mt-4 mb-2">3.2 Abuse of Infrastructure</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Submit scans, API calls, or other requests at rates or volumes that constitute a denial-of-service attack or that materially degrade the Service for other customers.</li>
              <li>Attempt to circumvent rate limits, scan quotas, payment controls, or other technical restrictions.</li>
              <li>Use the Service to generate AI outputs at scale for the purpose of reselling, redistributing, or republishing those outputs without our prior written consent.</li>
              <li>Reverse-engineer, decompile, or attempt to extract the source code, models, prompts, detection logic, or other proprietary components of the Service.</li>
              <li>Use automated means to probe, fuzz, or test the security of our infrastructure without prior written authorisation from us.</li>
            </ul>

            <h3 className="text-base font-semibold text-foreground mt-4 mb-2">3.3 Unlawful and Harmful Activity</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Use the Service in violation of any applicable law or regulation, including export control laws, privacy laws, computer-fraud laws, and intellectual property laws.</li>
              <li>Submit repositories containing CSAM (child sexual abuse material) or other illegal content.</li>
              <li>Use the Service to facilitate the development, deployment, or improvement of malware, ransomware, spyware, exploit kits, or other tools designed to harm computer systems or their users.</li>
              <li>Attempt to launder money, evade sanctions, or otherwise use the Service in connection with financial crimes.</li>
              <li>Use the Service to harass, threaten, or harm any individual or organisation.</li>
            </ul>

            <h3 className="text-base font-semibold text-foreground mt-4 mb-2">3.4 Account and Credential Misuse</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Share your API keys, account credentials, or payment methods with any third party without our prior written consent.</li>
              <li>Create multiple accounts to circumvent usage limits, payment requirements, or account suspensions.</li>
              <li>Impersonate any person or entity or misrepresent your affiliation with any person or entity.</li>
              <li>Use stolen credit cards, fraudulent payment instruments, or engage in friendly fraud (filing chargebacks for services rendered).</li>
            </ul>

            <h3 className="text-base font-semibold text-foreground mt-4 mb-2">3.5 Competitive Intelligence and Benchmarking</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Use the Service to benchmark, evaluate, or reverse-engineer our detection capabilities for the primary purpose of building a competing product, without our prior written consent.</li>
              <li>Systematically harvest scan results, module outputs, or AI-generated content to train or fine-tune any machine learning model without our prior written consent.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. Responsible Disclosure</h2>
            <p>
              If you discover a vulnerability in the GateTest platform, CLI, or API, please
              disclose it to us responsibly before public disclosure:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>Email: <a href="mailto:hello@gatetest.ai" className="text-accent-light hover:underline">hello@gatetest.ai</a> with subject line &quot;Security Disclosure&quot;</li>
              <li>Include a description of the vulnerability, steps to reproduce, and potential impact</li>
              <li>Give us a reasonable time to investigate and remediate before public disclosure (typically 90 days)</li>
              <li>Do not exploit the vulnerability beyond what is necessary to demonstrate the issue</li>
            </ul>
            <p className="mt-2">
              We will acknowledge your report within 5 business days, keep you informed of our
              progress, and publicly credit you (unless you prefer anonymity) once the issue is
              resolved. We do not currently operate a paid bug-bounty programme, but we may
              offer recognition or other courtesy acknowledgement at our discretion.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. Content You Submit</h2>
            <p>
              By submitting a repository URL or source files to GateTest, you represent and
              warrant that:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>You have the right to submit the code for scanning (you own it or have permission from the owner).</li>
              <li>The submission does not violate the intellectual property rights, privacy rights, or other rights of any third party.</li>
              <li>The submission does not contain content that is unlawful or that we are prohibited from processing under applicable law.</li>
            </ul>
            <p className="mt-2">
              We do not store your source code beyond what is necessary to complete the scan. See
              our{" "}
              <Link href="/legal/privacy" className="text-accent-light hover:underline">
                Privacy Policy
              </Link>{" "}
              for details on data retention.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">6. AI-Generated Output</h2>
            <p>
              GateTest uses large language models (including Claude by Anthropic) to generate
              code analysis, fix suggestions, and reports. You acknowledge that:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>AI-generated content may be inaccurate, incomplete, or inappropriate for your specific context.</li>
              <li>You are solely responsible for reviewing, testing, and validating any AI-generated fix before applying it to your codebase.</li>
              <li>You may not use AI-generated outputs as the sole basis for security certifications, compliance sign-offs, or representations to third parties without independent expert verification.</li>
              <li>We do not warrant that AI-generated outputs are free of hallucinations, biases, or errors.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. API Usage</h2>
            <p>If you access the Service via API:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>You must keep your API keys confidential and not share them with unauthorised parties.</li>
              <li>You are responsible for all API activity under your credentials, whether or not you authorised it.</li>
              <li>You must implement reasonable rate limiting on your client to avoid exceeding our published quotas.</li>
              <li>You must not use the API to build a product or service that directly competes with GateTest without our prior written consent, and you must not white-label the API output as your own proprietary scanning engine.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">8. GitHub App</h2>
            <p>If you install the GateTest GitHub App:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>You authorise GateTest to access the repositories you select in accordance with the permissions disclosed at install time and our Privacy Policy.</li>
              <li>You are responsible for ensuring the App is installed only on repositories where you have the right to grant such access.</li>
              <li>You must notify us immediately if the App is installed on a repository without your authorisation.</li>
              <li>You may revoke App access at any time through your GitHub settings.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">9. Consequences of Violation</h2>
            <p>
              If we determine, in our sole reasonable discretion, that you have violated this AUP,
              we may take any of the following actions:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li><strong>Warning.</strong> Issue a warning and require immediate remediation.</li>
              <li><strong>Suspension.</strong> Suspend your access to the Service, with or without prior notice, pending investigation or remediation.</li>
              <li><strong>Termination.</strong> Terminate your account and revoke all access to the Service. In cases of serious or repeated violations, termination is permanent.</li>
              <li><strong>Legal action.</strong> Pursue civil or criminal legal remedies where the violation constitutes unlawful conduct, including referral to law enforcement authorities.</li>
              <li><strong>Disclosure.</strong> Disclose relevant information to law enforcement, regulatory authorities, or affected third parties as required by law or as necessary to prevent harm.</li>
            </ul>
            <p className="mt-2">
              Accounts terminated for AUP violations are not entitled to a refund of any amounts
              paid. Where a violation causes us loss, we reserve the right to recover damages,
              costs, and fees to the extent permitted by the Terms of Service and applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">10. Reporting Violations</h2>
            <p>
              If you become aware of any use of the Service that violates this AUP, please
              report it to:{" "}
              <a href="mailto:hello@gatetest.ai" className="text-accent-light hover:underline">
                hello@gatetest.ai
              </a>{" "}
              with subject line &quot;AUP Violation Report&quot;. We investigate all reports and
              will follow up where appropriate, subject to confidentiality constraints.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">11. Changes to This Policy</h2>
            <p>
              We may update this AUP from time to time. We will notify you of material changes
              by posting a notice on gatetest.ai or by emailing you. Your continued use of the
              Service after the effective date of a revised AUP constitutes acceptance of the
              revised policy. If you disagree with a change, you may terminate your account in
              accordance with the Terms of Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">12. Contact</h2>
            <p>
              For questions about this policy:{" "}
              <a href="mailto:hello@gatetest.ai" className="text-accent-light hover:underline">
                hello@gatetest.ai
              </a>
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-border/30">
          <p className="text-xs text-muted mb-4">Other legal documents:</p>
          <div className="flex flex-wrap gap-4 text-xs">
            <Link href="/legal/terms" className="text-accent-light hover:underline">Terms of Service</Link>
            <Link href="/legal/privacy" className="text-accent-light hover:underline">Privacy Policy</Link>
            <Link href="/legal/refunds" className="text-accent-light hover:underline">Refund Policy</Link>
          </div>
          <div className="mt-6">
            <Link href="/" className="text-sm text-muted hover:text-foreground transition-colors">
              &larr; Back to gatetest.ai
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
