/**
 * SEO Module - Search engine optimization validation.
 * Checks meta tags, structured data, sitemaps, canonical URLs, and more.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

class SeoModule extends BaseModule {
  constructor() {
    super('seo', 'SEO & Metadata Validation');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const seoConfig = config.getModuleConfig('seo');
    const htmlFiles = this._collectFiles(projectRoot, ['.html']);

    for (const file of htmlFiles) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      // Skip pages explicitly excluded from search-engine indexing —
      // OG/Twitter/canonical/structured-data don't apply when the page
      // declares `<meta name="robots" content="noindex">` or similar.
      if (/<meta[^>]+name\s*=\s*["']robots["'][^>]+content\s*=\s*["'][^"']*noindex/i.test(content)) {
        continue;
      }

      this._checkTitle(relPath, content, seoConfig, result);
      this._checkMetaDescription(relPath, content, seoConfig, result);
      this._checkOpenGraph(relPath, content, result);
      this._checkTwitterCards(relPath, content, result);
      this._checkCanonical(relPath, content, result);
      this._checkStructuredData(relPath, content, result);
      this._checkHeadingSeo(relPath, content, result);
    }

    // Check for sitemap
    this._checkSitemap(projectRoot, result);

    // Check for robots.txt
    this._checkRobotsTxt(projectRoot, result);

    if (htmlFiles.length === 0) {
      result.addCheck('seo:files', true, { message: 'No HTML files to check' });
    }
  }

  _checkTitle(relPath, content, config, result) {
    const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
    if (!titleMatch) {
      result.addCheck(`seo:title:${relPath}`, false, {
        file: relPath,
        message: 'Missing <title> tag',
        suggestion: 'Add a unique, descriptive <title> (50-60 characters)',
      });
      return;
    }

    const title = titleMatch[1].trim();
    const maxLength = config.maxTitleLength || 60;

    if (title.length === 0) {
      result.addCheck(`seo:title-empty:${relPath}`, false, {
        file: relPath,
        message: 'Empty <title> tag',
        suggestion: 'Add descriptive page title',
      });
    } else if (title.length > maxLength) {
      result.addCheck(`seo:title-length:${relPath}`, false, {
        file: relPath,
        expected: `<= ${maxLength} characters`,
        actual: `${title.length} characters`,
        message: 'Title too long — may be truncated in search results',
        suggestion: `Shorten title to ${maxLength} characters or less`,
      });
    } else {
      result.addCheck(`seo:title:${relPath}`, true);
    }
  }

  _checkMetaDescription(relPath, content, config, result) {
    const descMatch = content.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) ||
                      content.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);

    if (!descMatch) {
      result.addCheck(`seo:description:${relPath}`, false, {
        file: relPath,
        message: 'Missing meta description',
        suggestion: 'Add <meta name="description" content="..."> (150-160 characters)',
      });
      return;
    }

    const desc = descMatch[1].trim();
    const maxLength = config.maxDescriptionLength || 160;

    if (desc.length > maxLength) {
      result.addCheck(`seo:description-length:${relPath}`, false, {
        file: relPath,
        expected: `<= ${maxLength} characters`,
        actual: `${desc.length} characters`,
        suggestion: `Shorten description to ${maxLength} characters`,
      });
    } else {
      result.addCheck(`seo:description:${relPath}`, true);
    }
  }

  _checkOpenGraph(relPath, content, result) {
    const ogTags = ['og:title', 'og:description', 'og:image', 'og:url'];
    for (const tag of ogTags) {
      const hasTag = new RegExp(`property=["']${tag}["']`, 'i').test(content) ||
                     new RegExp(`name=["']${tag}["']`, 'i').test(content);
      if (!hasTag) {
        result.addCheck(`seo:${tag}:${relPath}`, false, {
          file: relPath,
          message: `Missing Open Graph tag: ${tag}`,
          suggestion: `Add <meta property="${tag}" content="...">`,
        });
      }
    }
  }

  _checkTwitterCards(relPath, content, result) {
    const twitterTags = ['twitter:card', 'twitter:title', 'twitter:description'];
    for (const tag of twitterTags) {
      if (!content.includes(tag)) {
        result.addCheck(`seo:${tag}:${relPath}`, false, {
          file: relPath,
          message: `Missing Twitter Card tag: ${tag}`,
          suggestion: `Add <meta name="${tag}" content="...">`,
        });
      }
    }
  }

  _checkCanonical(relPath, content, result) {
    if (!/<link\s+[^>]*rel=["']canonical["']/i.test(content)) {
      result.addCheck(`seo:canonical:${relPath}`, false, {
        file: relPath,
        message: 'Missing canonical URL',
        suggestion: 'Add <link rel="canonical" href="...">',
      });
    }
  }

  _checkStructuredData(relPath, content, result) {
    const hasJsonLd = content.includes('application/ld+json');
    const hasMicrodata = content.includes('itemscope') || content.includes('itemtype');

    if (!hasJsonLd && !hasMicrodata) {
      result.addCheck(`seo:structured-data:${relPath}`, false, {
        file: relPath,
        message: 'No structured data (JSON-LD or microdata) found',
        suggestion: 'Add JSON-LD structured data for rich search results',
      });
    }
  }

  _checkHeadingSeo(relPath, content, result) {
    const h1Count = (content.match(/<h1\b/gi) || []).length;
    if (h1Count === 0) {
      result.addCheck(`seo:h1-missing:${relPath}`, false, {
        file: relPath,
        message: 'No <h1> tag found',
        suggestion: 'Add a single <h1> tag with the primary page topic',
      });
    } else if (h1Count > 1) {
      result.addCheck(`seo:h1-multiple:${relPath}`, false, {
        file: relPath,
        message: `${h1Count} <h1> tags found — should have exactly one`,
        suggestion: 'Use a single <h1> and structure with h2-h6',
      });
    }
  }

  _checkSitemap(projectRoot, result) {
    // Static file conventions + framework-generated conventions:
    // - Plain XML in repo / public/ / static/
    // - Next.js App Router: app/sitemap.{ts,js} or app/sitemap.xml/route.{ts,js}
    // - Next.js Pages Router or any framework dropping into public/
    // - website/ + frontend/ + apps/web/ subdir conventions
    const sitemapPaths = [
      'sitemap.xml', 'public/sitemap.xml', 'static/sitemap.xml',
      'website/public/sitemap.xml', 'website/sitemap.xml',
      'app/sitemap.ts', 'app/sitemap.js', 'app/sitemap.tsx', 'app/sitemap.jsx',
      'website/app/sitemap.ts', 'website/app/sitemap.js',
      'src/app/sitemap.ts', 'src/app/sitemap.js',
      'frontend/app/sitemap.ts', 'apps/web/app/sitemap.ts',
    ];
    const found = sitemapPaths.some(p => fs.existsSync(path.join(projectRoot, p)));

    if (!found) {
      result.addCheck('seo:sitemap', false, {
        message: 'No sitemap.xml or framework sitemap route found',
        suggestion: 'Generate a sitemap.xml (or app/sitemap.ts for Next.js App Router) for search engine discovery',
      });
    } else {
      result.addCheck('seo:sitemap', true);
    }
  }

  _checkRobotsTxt(projectRoot, result) {
    // Same dual-convention check as sitemap above.
    const robotsPaths = [
      'robots.txt', 'public/robots.txt', 'static/robots.txt',
      'website/public/robots.txt', 'website/robots.txt',
      'app/robots.ts', 'app/robots.js', 'app/robots.txt/route.ts',
      'website/app/robots.ts', 'website/app/robots.js',
      'src/app/robots.ts', 'src/app/robots.js',
      'frontend/app/robots.ts', 'apps/web/app/robots.ts',
    ];
    const found = robotsPaths.some(p => fs.existsSync(path.join(projectRoot, p)));

    if (!found) {
      result.addCheck('seo:robots-txt', false, {
        message: 'No robots.txt found',
        suggestion: 'Create a robots.txt to guide search engine crawlers',
      });
    } else {
      result.addCheck('seo:robots-txt', true);
    }
  }
}

module.exports = SeoModule;
