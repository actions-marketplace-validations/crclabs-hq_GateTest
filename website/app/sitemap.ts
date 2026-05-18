import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://gatetest.ai";
  const now = new Date();

  return [
    // Core
    { url: base, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/github/setup`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/dashboard`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },

    // Comparison pages — high-intent "X alternative" searches
    { url: `${base}/compare/sonarqube`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/compare/snyk`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/compare/eslint`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/compare/github-code-scanning`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/compare/deepsource`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },

    // Use-case pages — framework/language targeting
    { url: `${base}/for/nextjs`, lastModified: now, changeFrequency: "monthly", priority: 0.85 },
    { url: `${base}/for/typescript`, lastModified: now, changeFrequency: "monthly", priority: 0.85 },

    // Legal
    { url: `${base}/legal/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/refunds`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/acceptable-use`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}

