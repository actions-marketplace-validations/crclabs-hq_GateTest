import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import Problem from "./components/Problem";
import AiNative from "./components/AiNative";
import MonsterMoves from "./components/MonsterMoves";
import HowItWorks from "./components/HowItWorks";
import Modules from "./components/Modules";
import Install from "./components/Install";
import Comparison from "./components/Comparison";
import Integrations from "./components/Integrations";
import ContinuousScanning from "./components/ContinuousScanning";
import GateRules from "./components/GateRules";
import Pricing from "./components/Pricing";
import Cta from "./components/Cta";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Problem />
        <AiNative />
        <MonsterMoves />
        <HowItWorks />
        <Modules />
        <Install />
        <Comparison />
        <Integrations />
        <ContinuousScanning />
        <GateRules />
        <Pricing />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
