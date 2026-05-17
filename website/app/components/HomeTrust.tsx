/**
 * <HomeTrust> — frameworks scanned + honest customer mention.
 *
 * Two parts:
 *   1. A row of frameworks we scan, text-only (no logo CDN, no asset bloat).
 *   2. "Used internally by Crontech.ai and Gluecron.com" — both real,
 *      listed in CLAUDE.md PROTECTED PLATFORMS section.
 *
 * No fabricated customer logos. No fake testimonials. The audience can
 * spot it instantly.
 */

const FRAMEWORKS = [
  "Next.js",
  "React",
  "Vue",
  "Express",
  "Fastify",
  "Nest",
  "Prisma",
  "Drizzle",
  "Mongo",
  "Postgres",
  "Docker",
  "Kubernetes",
  "Terraform",
  "AWS",
  "GCP",
  "Azure",
  "Python",
  "Go",
  "Rust",
  "Java",
  "Ruby",
  "PHP",
  "C#",
  "Kotlin",
  "Swift",
];

export default function HomeTrust() {
  return (
    <section
      aria-label="What we scan"
      className="py-16 px-6 border-t border-border bg-background-alt"
    >
      <div className="mx-auto max-w-6xl">
        <p className="text-center text-xs uppercase tracking-wider text-muted font-semibold mb-8">
          Scans every major framework, runtime, and infra primitive
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2 max-w-4xl mx-auto mb-12">
          {FRAMEWORKS.map((f) => (
            <span
              key={f}
              className="px-3 py-1.5 rounded-full bg-surface-solid border border-border text-xs font-medium text-foreground/85"
            >
              {f}
            </span>
          ))}
        </div>

        <div className="max-w-3xl mx-auto rounded-2xl border border-border bg-surface-solid p-6 sm:p-8">
          <div className="text-center">
            <p className="text-xs uppercase tracking-wider text-muted font-semibold mb-3">
              Eaten our own dog food
            </p>
            <p className="text-base text-foreground/90 leading-relaxed">
              GateTest currently protects{" "}
              <a
                href="https://crontech.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="font-bold text-accent hover:underline"
              >
                Crontech.ai
              </a>{" "}
              and{" "}
              <a
                href="https://gluecron.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-bold text-accent hover:underline"
              >
                Gluecron.com
              </a>{" "}
              as a CI gate.
            </p>
            <p className="text-sm text-muted mt-2">
              Same engine, same rules, same gate. The integration script is
              published — feel free to clone the workflow.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
