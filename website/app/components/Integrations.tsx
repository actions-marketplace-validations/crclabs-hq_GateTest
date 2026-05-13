const platforms = [
  {
    category: "Websites",
    items: ["React", "Next.js", "Vue", "Nuxt", "Svelte", "Astro", "Angular", "Static HTML"],
    icon: "W",
  },
  {
    category: "Mobile Apps",
    items: ["React Native", "Flutter", "Ionic", "Capacitor", "PWAs", "Expo"],
    icon: "M",
  },
  {
    category: "APIs & Backend",
    items: ["Node.js", "Express", "Fastify", "NestJS", "Django", "FastAPI", "Rails"],
    icon: "A",
  },
  {
    category: "Desktop Apps",
    items: ["Electron", "Tauri", "CEF", "WebView2"],
    icon: "D",
  },
];

const ciProviders = [
  "GitHub Actions",
  "GitLab CI",
  "CircleCI",
  "Jenkins",
  "Bitbucket Pipelines",
  "Azure DevOps",
  "AWS CodePipeline",
  "Vercel",
  "Netlify",
  "Railway",
];

const aiTools = [
  "Claude",
  "Claude Code",
  "GitHub Copilot",
  "Cursor",
  "Windsurf",
  "Cody",
  "Tabnine",
  "Amazon Q",
];

export default function Integrations() {
  return (
    <section id="integrations" className="py-24 px-6 border-t border-border/30 grid-bg relative">
      <div className="hidden md:block absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-accent/5 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="text-sm font-semibold text-accent-light uppercase tracking-wider">
            Universal Integration
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4">
            Test <span className="gradient-text">anything you build</span>.
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            Websites, mobile apps, APIs, desktop apps — GateTest integrates with
            every platform, every CI/CD provider, and every AI coding tool.
          </p>
        </div>

        {/* Platform grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
          {platforms.map((platform) => (
            <div
              key={platform.category}
              className="rounded-xl p-6 border border-border bg-surface hover:border-accent/30 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center font-[var(--font-mono)] font-bold text-accent-light mb-4">
                {platform.icon}
              </div>
              <h3 className="font-semibold mb-3">{platform.category}</h3>
              <div className="flex flex-wrap gap-1.5">
                {platform.items.map((item) => (
                  <span
                    key={item}
                    className="px-2 py-0.5 rounded text-xs bg-surface-light border border-border text-muted"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* CI/CD and AI tools */}
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="rounded-xl p-6 border border-border bg-surface">
            <h3 className="font-semibold mb-1">CI/CD Providers</h3>
            <p className="text-sm text-muted mb-4">Drop GateTest into any pipeline. One command.</p>
            <div className="flex flex-wrap gap-2">
              {ciProviders.map((provider) => (
                <span
                  key={provider}
                  className="px-3 py-1.5 rounded-lg text-sm bg-surface-light border border-border text-foreground"
                >
                  {provider}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-xl p-6 border border-accent/30 bg-accent/5">
            <h3 className="font-semibold mb-1 text-accent-light">AI Coding Tools</h3>
            <p className="text-sm text-muted mb-4">Built to catch what AI gets wrong.</p>
            <div className="flex flex-wrap gap-2">
              {aiTools.map((tool) => (
                <span
                  key={tool}
                  className="px-3 py-1.5 rounded-lg text-sm bg-accent/10 border border-accent/20 text-accent-light"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
