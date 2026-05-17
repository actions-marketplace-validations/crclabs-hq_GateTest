/**
 * Homepage composition — world-class rebuild for HN / GitHub Marketplace
 * / npm launch.
 *
 * Section order:
 *   1. Navbar
 *   2. Hero  — live URL scan, "One gate. 91 modules. Self-healing CI."
 *   3. HomeKills  — what 12 tools we replace, with flip tiles + full table
 *   4. HomeFlywheel — 4-layer fix flow (AST -> Rule -> Recipe -> Claude)
 *   5. HomeSelfScan — "GREEN" trust badge with module list
 *   6. HomeCode — install snippets (npx, GitHub Action, CLI cheat-sheet)
 *   7. Pricing — 4 tiers + Continuous subscription card
 *   8. HomeFaq — HN-skeptic FAQ
 *   9. HomeTrust — frameworks scanned + Crontech/Gluecron
 *  10. Footer
 *
 * Sections retained from the previous homepage are intentionally dropped:
 *   - Problem / AiNative / HowItWorks / Modules / Install / Comparison /
 *     Integrations / ContinuousScanning / GateRules / Cta
 * The new homepage carries the same arguments in tighter, denser, more
 * code-forward form — Hacker News bar. The dropped components are not
 * deleted (other pages may reference them).
 */

import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import HomeKills from "./components/HomeKills";
import HomeFlywheel from "./components/HomeFlywheel";
import HomeSelfScan from "./components/HomeSelfScan";
import HomeCode from "./components/HomeCode";
import Pricing from "./components/Pricing";
import HomeFaq from "./components/HomeFaq";
import HomeTrust from "./components/HomeTrust";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <HomeKills />
        <HomeFlywheel />
        <HomeSelfScan />
        <HomeCode />
        <Pricing />
        <HomeFaq />
        <HomeTrust />
      </main>
      <Footer />
    </>
  );
}
