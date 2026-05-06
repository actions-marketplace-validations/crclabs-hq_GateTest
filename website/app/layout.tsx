import type { Metadata, Viewport } from "next";
import "./globals.css";
import PreLaunchBanner from "./components/PreLaunchBanner";

// Next.js 16 — viewport is a separate export from metadata.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f766e",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://gatetest.ai"),
  title: "GateTest — AI writes fast. GateTest keeps it honest.",
  description:
    "90 modules scan your entire codebase. Security, accessibility, performance, and more. We find the bugs AND fix them. Pay only when the scan completes.",
  keywords: [
    "QA",
    "testing",
    "quality assurance",
    "AI testing",
    "security scanning",
    "accessibility",
    "performance",
    "visual regression",
    "CI/CD",
    "code quality",
    "mutation testing",
    "auto-fix",
    "code review",
    "SonarQube alternative",
    "Snyk alternative",
    "GitHub code scanning",
    "static analysis",
    "OWASP",
    "WCAG",
    "SEO audit",
  ],
  alternates: {
    canonical: "https://gatetest.ai",
  },
  openGraph: {
    title: "GateTest — AI writes fast. GateTest keeps it honest.",
    description:
      "90 modules scan your entire codebase. We find the bugs AND fix them. Pay only when the scan completes.",
    url: "https://gatetest.io",
    siteName: "GateTest",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "GateTest — AI writes fast. GateTest keeps it honest.",
    description:
      "90 modules scan your entire codebase. We find the bugs AND fix them. Pay only when the scan completes.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/icon-180.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0f766e" />
      </head>
      <body className="min-h-full flex flex-col">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "GateTest",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Any",
              url: "https://gatetest.ai",
              description:
                "AI-powered QA platform that scans your entire codebase with 90 modules — security, supply chain, auth flaws, CI hardening, and more. Pay only when the scan completes.",
              offers: [
                {
                  "@type": "Offer",
                  name: "Quick Scan",
                  price: "29.00",
                  priceCurrency: "USD",
                  description: "4 modules: syntax, lint, secrets, code quality",
                },
                {
                  "@type": "Offer",
                  name: "Full Scan",
                  price: "99.00",
                  priceCurrency: "USD",
                  description:
                    "All 90 modules including AI code review, security, supply chain, auth flaws, and more",
                },
              ],
            }),
          }}
        />
        <PreLaunchBanner />
        <main>{children}</main>
      </body>
    </html>
  );
}
