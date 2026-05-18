import Link from "next/link";
import StackBar from "./StackBar";

export default function Footer() {
  return (
    <footer className="relative border-t border-border py-12 px-6 bg-background-warm">
      <div className="footer-accent-bar absolute top-0 left-0 right-0" aria-hidden="true" />
      <div className="mx-auto max-w-6xl">
        <StackBar currentProduct="GateTest" />
        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-12">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-6 h-6 rounded bg-accent flex items-center justify-center">
                <span className="text-white font-bold text-xs font-[var(--font-mono)]">G</span>
              </div>
              <span className="font-bold">
                Gate<span className="gradient-text">Test</span>
              </span>
            </div>
            <p className="text-sm text-muted leading-relaxed">
              The advanced QA gate between AI and GitHub. Nothing ships unless it&apos;s pristine.
            </p>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-4">Product</h4>
            <ul className="space-y-2">
              <li><a href="#features" className="text-sm text-muted hover:text-foreground transition-colors">Features</a></li>
              <li><a href="#modules" className="text-sm text-muted hover:text-foreground transition-colors">Modules</a></li>
              <li><a href="#pricing" className="text-sm text-muted hover:text-foreground transition-colors">Pricing</a></li>
              <li><a href="#comparison" className="text-sm text-muted hover:text-foreground transition-colors">Compare</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-4">Resources</h4>
            <ul className="space-y-2">
              <li><a href="https://github.com/ccantynz-alt/GateTest#readme" target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">Documentation</a></li>
              <li><a href="https://github.com/ccantynz-alt/GateTest" target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">GitHub</a></li>
              <li><a href="https://github.com/ccantynz-alt/GateTest/releases" target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">Changelog</a></li>
              <li><a href="https://github.com/ccantynz-alt/GateTest/issues" target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">Report Issue</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-4">Company</h4>
            <ul className="space-y-2">
              <li><Link href="/#features" className="text-sm text-muted hover:text-foreground transition-colors">About</Link></li>
              <li><a href="mailto:hello@gatetest.ai" className="text-sm text-muted hover:text-foreground transition-colors">Contact</a></li>
              <li><a href="/legal/privacy" className="text-sm text-muted hover:text-foreground transition-colors">Privacy Policy</a></li>
              <li><a href="/legal/terms" className="text-sm text-muted hover:text-foreground transition-colors">Terms of Service</a></li>
              <li><a href="/legal/refunds" className="text-sm text-muted hover:text-foreground transition-colors">Refund Policy</a></li>
              <li><a href="/legal/acceptable-use" className="text-sm text-muted hover:text-foreground transition-colors">Acceptable Use</a></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-border/30 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted">
            &copy; {new Date().getFullYear()} GateTest. All rights reserved.
          </p>
          <p className="text-xs text-muted">
            AI writes fast. GateTest keeps it honest.
          </p>
        </div>
      </div>
    </footer>
  );
}
