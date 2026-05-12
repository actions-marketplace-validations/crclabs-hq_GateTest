/**
 * Links Module - Broken link detection for internal and external links.
 * Crawls HTML files and validates all href/src references.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

class LinksModule extends BaseModule {
  constructor() {
    super('links', 'Broken Link Detection');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const linksConfig = config.getModuleConfig('links') || {};

    // Scan HTML, JSX, TSX, Vue, Svelte, and Markdown files — not just static HTML
    const allExtensions = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.md', '.mdx'];
    const allFiles = this._collectFiles(projectRoot, allExtensions);

    if (allFiles.length === 0) {
      result.addCheck('links:files', true, { message: 'No template/markup files to check' });
      return;
    }

    const internalLinks = [];
    const externalLinks = new Set();
    const deadLinks = []; // href="#" or javascript:void(0)
    const brokenInternal = [];

    for (const file of allFiles) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');
      const ext = path.extname(file);

      // Pattern set 1: HTML-style href/src attributes (works for HTML, JSX, TSX, Vue, Svelte)
      const hrefRegex = /(?:href|src)\s*=\s*["'{]?\s*["'`]([^"'`{}\s>]+)/gi;
      let match;
      while ((match = hrefRegex.exec(content)) !== null) {
        const link = match[1].trim();
        this._categorizeLink(link, relPath, internalLinks, externalLinks, deadLinks);
      }

      // Pattern set 2: JSX/TSX — to="" prop (Next.js Link, React Router)
      if (['.jsx', '.tsx', '.js', '.ts'].includes(ext)) {
        const toRegex = /\bto\s*=\s*["'`]([^"'`]+)/gi;
        while ((match = toRegex.exec(content)) !== null) {
          const link = match[1].trim();
          this._categorizeLink(link, relPath, internalLinks, externalLinks, deadLinks);
        }
      }

      // Pattern set 3: Markdown links [text](url)
      if (['.md', '.mdx'].includes(ext)) {
        const mdRegex = /\]\(([^)\s]+)/g;
        while ((match = mdRegex.exec(content)) !== null) {
          const link = match[1].trim();
          this._categorizeLink(link, relPath, internalLinks, externalLinks, deadLinks);
        }
      }

      // Pattern set 4: Detect dead href patterns in ALL template files
      const deadPatterns = [
        { regex: /href\s*=\s*["']#["']/g, type: 'href="#"' },
        { regex: /href\s*=\s*["']#!["']/g, type: 'href="#!"' },
        { regex: /href\s*=\s*["']javascript:\s*void\s*\(0\)["']/gi, type: 'javascript:void(0)' },
        { regex: /href\s*=\s*["']javascript:;["']/gi, type: 'javascript:;' },
        { regex: /href\s*=\s*["']\s*["']/g, type: 'empty href' },
      ];

      for (const { regex, type } of deadPatterns) {
        const matches = content.match(regex);
        if (matches) {
          for (const m of matches) {
            // Find approximate line number
            const idx = content.indexOf(m);
            const line = content.substring(0, idx).split('\n').length;
            deadLinks.push({ href: type, source: relPath, line });
          }
        }
      }
    }

    // Validate internal links (resolve against project root)
    const uniqueInternal = new Map();
    for (const { href, source } of internalLinks) {
      const key = `${source}::${href}`;
      if (uniqueInternal.has(key)) continue;
      uniqueInternal.set(key, { href, source });

      // Skip dynamic routes (e.g., /users/[id])
      if (/[\[\]{}$]/.test(href)) continue;
      // Skip fragment-only anchors (e.g. #pricing, #features) — those
      // refer to elements with matching `id=`, not to files. They're
      // valid intra-page navigation, not broken file references.
      if (href.startsWith('#')) continue;
      // Skip mailto / tel / javascript / data / blob protocols.
      if (/^(?:mailto|tel|javascript|data|blob):/i.test(href)) continue;
      // Skip absolute URLs that start with / (these are route paths, not filesystem paths)
      // Only validate relative file references
      if (!href.startsWith('/') && !href.startsWith('http')) {
        const resolved = path.resolve(path.dirname(path.join(projectRoot, source)), href);
        if (!fs.existsSync(resolved)) {
          brokenInternal.push({ href, source });
        }
      }
    }

    // Report dead links (href="#", javascript:void(0), etc.)
    if (deadLinks.length > 0) {
      result.addCheck('links:dead-links', false, {
        message: `${deadLinks.length} dead/placeholder link(s) found (href="#", javascript:void(0), empty href)`,
        details: deadLinks.slice(0, 30),
        suggestion: 'Replace placeholder hrefs with real destinations or use <button> for actions',
      });
    }

    if (brokenInternal.length > 0) {
      result.addCheck('links:internal', false, {
        message: `${brokenInternal.length} broken internal link(s)`,
        details: brokenInternal.slice(0, 20),
        suggestion: 'Fix or remove broken internal links',
      });
    } else {
      result.addCheck('links:internal', true, {
        message: `${uniqueInternal.size} internal links verified across ${allFiles.length} files`,
      });
    }

    // External links: report count
    result.addCheck('links:external-count', true, {
      message: `${externalLinks.size} external links found — use "gatetest --check-external" to validate`,
    });

    // Check for javascript: links (security issue) across ALL file types
    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (/href\s*=\s*["']javascript:(?!void|;)/i.test(content)) {
        result.addCheck(`links:javascript-href:${path.relative(projectRoot, file)}`, false, {
          file: path.relative(projectRoot, file),
          message: 'javascript: protocol in href — security risk',
          suggestion: 'Replace javascript: links with proper event handlers',
        });
      }
    }

    // Summary
    result.addCheck('links:summary', true, {
      message: `Scanned ${allFiles.length} files (${allExtensions.join(', ')}): ${uniqueInternal.size} internal, ${externalLinks.size} external, ${deadLinks.length} dead`,
    });
  }

  _categorizeLink(link, source, internalLinks, externalLinks, deadLinks) {
    if (!link || link.length === 0) return;
    if (link.startsWith('http://') || link.startsWith('https://') || link.startsWith('//')) {
      externalLinks.add(link);
    } else if (link.startsWith('mailto:') || link.startsWith('tel:') || link.startsWith('data:')) {
      // Skip non-resource links
    } else if (link === '#' || link === '#!' || /^javascript:/i.test(link)) {
      // Dead/placeholder links — tracked separately
    } else {
      internalLinks.push({ href: link, source });
    }
  }
}

module.exports = LinksModule;
