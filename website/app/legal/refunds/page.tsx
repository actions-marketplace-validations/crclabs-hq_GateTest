import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Refund Policy — GateTest",
  description: "GateTest refund and cancellation policy.",
};

export default function Refunds() {
  return (
    <div className="min-h-screen grid-bg px-6 py-24">
      <div className="max-w-3xl mx-auto prose-invert">
        <h1 className="text-3xl font-bold mb-2">Refund &amp; Cancellation Policy</h1>
        <p className="text-sm text-muted mb-8">Effective date: April 9, 2026</p>

        {/* DRAFT — requires attorney review. Priority review items: (1) chargeback-waiver language
        (may be unenforceable against some card-network rules and consumer-protection regimes);
        (2) the characterisation of a delivered scan as "service rendered" for digital-services
        refund exceptions under EU Consumer Rights Directive Art. 16(m); (3) consumer cooling-off
        overrides for consumers in NZ, EU/UK, and Australia; (4) subscription cancellation terms
        for Continuous tier vs state-level automatic-renewal laws (California SB-313, etc.). */}

        <div className="space-y-6 text-sm text-muted leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">1. Payment Model — Pay on Completion Explained</h2>
            <p>
              GateTest uses a <strong>hold-then-charge (pay-on-completion)</strong> payment model
              for per-scan purchases. Here is exactly how it works:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Step 1 — Hold.</strong> When you initiate a scan, your payment method is
                authorised for the full scan amount. This is a Stripe authorisation, not a
                capture; no money moves yet.
              </li>
              <li>
                <strong>Step 2 — Run.</strong> GateTest attempts to run the scan you purchased. The
                scan either completes and produces a report, or it fails and produces no report.
              </li>
              <li>
                <strong>Step 3A — Success.</strong> If the scan completes and a scan report is
                delivered to you (via the web UI, email, PR comment, or API response), the hold is
                <strong> captured</strong> and you are billed the full scan amount. Delivery of
                the report is the service rendered. See Section 3 below for what
                &quot;delivery&quot; means and what it does <em>not</em> mean.
              </li>
              <li>
                <strong>Step 3B — Failure.</strong> If the scan cannot be completed for any reason
                attributable to us (see Section 2), the hold is <strong>released</strong> and you
                are not billed. You do not need to request a release — it is automatic.
              </li>
            </ul>
            <p className="mt-2">
              This model is designed so that you pay only for scans that actually produce a
              report. It is not a money-back guarantee on the contents of the report and does not
              entitle you to a refund if you are dissatisfied with the findings.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">2. Scan Failure = Automatic Release (No Refund Request Needed)</h2>
            <p>
              When a scan cannot complete, the Stripe authorisation expires without capture and
              you are <strong>NOT charged</strong>. <strong>No refund request is required.</strong>
              The release is automatic and driven by the Stripe hold lifecycle. You will never be
              billed for a scan that did not produce a report.
            </p>
            <p className="mt-2">Circumstances that trigger automatic release include:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>The scan cannot access your repository (permissions error, private repo without access, authentication failure, GitHub App uninstalled mid-flight)</li>
              <li>The scan fails due to a GateTest infrastructure or technical error</li>
              <li>GitHub, or another upstream provider we depend on, is experiencing an outage that prevents repository access or scan completion</li>
              <li>The scan does not complete within the expected timeframe and is timed out</li>
              <li>A force-majeure event (see Terms of Service, Section 25) prevents completion</li>
              <li>Any other failure on our side that prevents delivery of a scan report</li>
            </ul>
            <p className="mt-2">
              The hold typically drops from your statement within three (3) to seven (7) business
              days, depending on your bank or card issuer. Some institutions may show the hold
              for up to fourteen (14) days before it clears. We have no control over this clearing
              timeline; if the hold persists beyond fourteen (14) days, contact your card issuer
              and, if needed, email hello@gatetest.ai so we can confirm the authorisation was not
              captured.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">3. Scan Success = Report Delivered = Service Rendered (No Refund)</h2>
            <p>
              Once a scan has completed successfully and a report has been delivered, the payment
              is captured and the Service is considered <strong>rendered and fulfilled</strong>.
              Because scan reports are digital services that are generated on demand and delivered
              instantly, <strong>completed scans are non-refundable except as provided in Section 4
              below and as required by applicable consumer-protection law.</strong>
            </p>
            <p className="mt-2">
              <strong>What counts as &quot;delivered&quot;.</strong> The Service is delivered when
              a scan run completes and a scan report is made available to you through any of the
              following channels: the web UI at gatetest.ai, the dashboard or scan-status page, an
              email containing the report or a link to it, a pull-request comment or commit-status
              check on your repository, or an API response. The scan report, analysis results, and
              any auto-fix pull requests constitute the delivered service.
            </p>
            <p className="mt-2">
              <strong>What delivery does not mean.</strong> Delivery means that the modules you
              purchased ran and produced output. Delivery does <strong>NOT</strong> mean: (a)
              that any minimum or maximum number of findings was produced; (b) that any finding
              is correct, actionable, or severe; (c) that your code is free of defects, secure,
              or compliant; (d) that the report matches your subjective expectations; or (e) that
              auto-fix pull requests, if any, are ready to merge without review. A &quot;clean&quot;
              scan report (zero findings) is a valid delivered service, as is a report with
              findings you disagree with.
            </p>
            <p className="mt-2">
              <strong>Consent.</strong> By purchasing a scan, you expressly request that the
              Service begin immediately and acknowledge that, where permitted by applicable law,
              you will lose any statutory right of withdrawal or cancellation once performance
              has begun with your consent. Where your jurisdiction grants a non-waivable
              cooling-off period that applies notwithstanding this consent, that period applies
              and prevails.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">4. Exceptions — When We Will Issue a Refund</h2>
            <p>
              We will issue a full refund for a completed scan if:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>The scan report was materially incomplete (e.g., major modules failed to run but were listed as included in your tier)</li>
              <li>You were charged a different amount than the price displayed at the time of purchase</li>
              <li>A duplicate charge occurred due to a technical error</li>
              <li>The auto-fix tier was purchased but no pull request was delivered</li>
            </ul>
            <p className="mt-2">
              Refund requests must be submitted within <strong>7 days</strong> of the scan delivery date
              to{" "}
              <a href="mailto:hello@gatetest.ai" className="text-accent-light hover:underline">
                hello@gatetest.ai
              </a>{" "}
              with your scan ID or Stripe receipt. We will review and respond within 3 business days.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">5. What Is NOT Grounds for a Refund</h2>
            <p>We do not issue refunds in the following situations:</p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>You disagree with the scan results or believe a finding is a false positive — scan results are automated analysis, not a guarantee (see Terms of Service, Section 6)</li>
              <li>The scan passed but bugs were later found in your code — a passing scan does not guarantee bug-free code</li>
              <li>You did not review auto-fix changes before merging and they caused issues — review responsibility is yours (see Terms of Service, Section 7)</li>
              <li>You purchased a higher tier than needed — you received the service described for that tier</li>
              <li>Your repository had no issues and the scan &quot;didn&apos;t find anything&quot; — a clean scan is a valid result</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">6. Continuous Subscription — Cancellation Terms</h2>
            <p>
              For the Continuous plan (currently US$49 per month per account, subject to change
              on notice):
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2">
              <li>
                <strong>Cancel anytime.</strong> You may cancel at any time, through your account
                settings or by emailing hello@gatetest.ai. We intend to offer a cancellation flow
                at least as easy as the sign-up flow.
              </li>
              <li>
                <strong>Effective at end of billing period.</strong> Cancellation takes effect at
                the end of the current billing period. Your subscription will not renew for the
                next period.
              </li>
              <li>
                <strong>Access until end of paid period.</strong> You retain access to the
                Continuous scanning features until the end of the billing period you have paid for,
                unless your account is suspended or terminated under the Terms of Service.
              </li>
              <li>
                <strong>No prorated refunds.</strong> No refunds are issued for partial months or
                for unused portions of a billing period. No refunds are issued for prior billing
                periods.
              </li>
              <li>
                <strong>Failed payments.</strong> If a recurring charge fails, we will attempt
                to charge your payment method up to three (3) times over seven (7) days (see
                Terms of Service, Section 18). If all attempts fail, the subscription is paused.
                No data is deleted during the pause period.
              </li>
              <li>
                <strong>Non-waivable consumer rights.</strong> Nothing in this Section limits any
                non-waivable statutory right to a refund or to cancellation that applies in your
                jurisdiction (including under the NZ Consumer Guarantees Act 1993, the Australian
                Consumer Law, or EU / UK consumer-rights law).
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">7. Free CLI Tool</h2>
            <p>
              The GateTest CLI tool is free and open source under the MIT License. No payments are
              involved and no refund policy applies. The CLI is provided &quot;as is&quot; without
              warranty.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">8. Chargebacks and Payment Disputes</h2>
            <p>
              <strong>8.1 Contact us first.</strong> If you believe a charge is incorrect, please
              contact{" "}
              <a href="mailto:hello@gatetest.ai" className="text-accent-light hover:underline">
                hello@gatetest.ai
              </a>{" "}
              before filing a chargeback with your bank or card issuer. We resolve most billing
              issues within one (1) business day and we can typically issue a refund or credit
              faster than the chargeback process.
            </p>
            <p className="mt-2">
              <strong>8.2 Waiver of chargeback for scans rendered.</strong> To the maximum extent
              permitted by applicable law and your card-network rules, and without limiting any
              non-waivable statutory right, you agree <strong>not to file a chargeback or payment
              dispute for any scan for which a report was delivered to you</strong>, unless you
              have first contacted us with a good-faith refund request under Section 4 and we
              have declined or failed to respond within ten (10) business days. This waiver does
              not apply to unauthorised transactions, clear billing errors (duplicate charges,
              wrong amount), or any dispute reserved to you by law.
            </p>
            <p className="mt-2">
              <strong>8.3 Defence of disputes.</strong> Where a chargeback is filed, we will
              provide all relevant transaction evidence to your bank or the card network,
              including proof of account authentication, scan initiation, scan completion, report
              delivery, applicable terms accepted at purchase, and any correspondence with you.
            </p>
            <p className="mt-2">
              <strong>8.4 Consequences.</strong> Filing a chargeback in breach of Section 8.2 may
              result in (a) immediate suspension of your account pending resolution;
              (b) termination of your account if the chargeback is determined to be illegitimate;
              (c) recovery of reasonable costs incurred by us in responding to the chargeback,
              including bank fees, card-network fees, and reasonable administrative costs; and
              (d) our refusal to accept future payments from the payment method used.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">9. How Refunds Are Processed</h2>
            <p>
              Approved refunds are processed via Stripe to the original payment method. Refunds
              typically appear on your statement within 5-10 business days, depending on your bank.
              We will send email confirmation when a refund is initiated.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-2">10. Contact</h2>
            <p>
              For billing questions, refund requests, or payment disputes:{" "}
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
            <Link href="/legal/acceptable-use" className="text-accent-light hover:underline">Acceptable Use Policy</Link>
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
