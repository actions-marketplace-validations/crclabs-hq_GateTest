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

    // Static dev fixtures (e.g. website/public/logos.html — logo grid for
    // screenshots, not a customer-facing route) shouldn't be checked for
    // customer-facing SEO metadata.
    const INTERNAL_PATH_RE = /(?:^|\/)(?:website\/public\/)/;

    for (const file of htmlFiles) {
      const relPath = path.relative(projectRoot, file);
      const normalised = relPath.replace(/\\/g, '/');
      if (INTERNAL_PATH_RE.test('/' + normalised)) continue;
      const content = fs.readFileSync(file, 'utf-8');

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
    const sitemapPaths = ['sitemap.xml', 'public/sitemap.xml', 'static/sitemap.xml'];
    const found = sitemapPaths.some(p => fs.existsSync(path.join(projectRoot, p)));

    if (!found) {
      result.addCheck('seo:sitemap', false, {
        message: 'No sitemap.xml found',
        suggestion: 'Generate a sitemap.xml for search engine discovery',
      });
    } else {
      result.addCheck('seo:sitemap', true);
    }
  }

  _checkRobotsTxt(projectRoot, result) {
    const robotsPaths = ['robots.txt', 'public/robots.txt', 'static/robots.txt'];
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
