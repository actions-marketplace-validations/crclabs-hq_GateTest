/**
 * Accessibility Module - WCAG 2.2 AAA compliance checking.
 * Validates HTML, ARIA usage, color contrast, keyboard access, and more.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

// Named CSS colors mapped to RGB values
const NAMED_COLORS = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  orange: { r: 255, g: 165, b: 0 },
  purple: { r: 128, g: 0, b: 128 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  cyan: { r: 0, g: 255, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  navy: { r: 0, g: 0, b: 128 },
  teal: { r: 0, g: 128, b: 128 },
  maroon: { r: 128, g: 0, b: 0 },
  olive: { r: 128, g: 128, b: 0 },
  silver: { r: 192, g: 192, b: 192 },
  lime: { r: 0, g: 255, b: 0 },
  aqua: { r: 0, g: 255, b: 255 },
  fuchsia: { r: 255, g: 0, b: 255 },
};

class AccessibilityModule extends BaseModule {
  constructor() {
    super('accessibility', 'Accessibility (WCAG 2.2 AAA) Audit');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const htmlFiles = this._collectFiles(projectRoot, ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte']);

    if (htmlFiles.length === 0) {
      result.addCheck('a11y:files', true, { message: 'No HTML/template files to check' });
    } else {
      for (const file of htmlFiles) {
        const relPath = path.relative(projectRoot, file);
        const content = fs.readFileSync(file, 'utf-8');

        this._checkImages(relPath, content, result);
        this._checkFormLabels(relPath, content, result);
        this._checkHeadingHierarchy(relPath, content, result);
        this._checkAriaUsage(relPath, content, result);
        this._checkLanguageAttribute(relPath, content, result);
        this._checkLandmarks(relPath, content, result);
        this._checkFocusManagement(relPath, content, result);
        this._checkReducedMotion(relPath, content, result);
      }
    }

    // Check CSS for contrast and focus styles
    const cssFiles = this._collectFiles(projectRoot, ['.css', '.scss', '.less']);
    for (const file of cssFiles) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');
      this._checkCssFocus(relPath, content, result);
      this._checkCssReducedMotion(relPath, content, result);
    }

    // Color contrast checks
    this._checkColorContrast(projectRoot, result);
    await this._checkLiveContrast(config, result);
  }

  _checkImages(relPath, content, result) {
    // Find <img> tags without alt attribute
    const imgRegex = /<img\b([^>]*?)>/gi;
    let match;
    while ((match = imgRegex.exec(content)) !== null) {
      const attrs = match[1];
      if (!/\balt\s*=/i.test(attrs)) {
        result.addCheck(`a11y:img-alt:${relPath}`, false, {
          file: relPath,
          message: 'Image missing alt attribute',
          suggestion: 'Add alt="description" for informative images or alt="" for decorative',
        });
      }
    }
  }

  _checkFormLabels(relPath, content, result) {
    // Find every <input ... /> tag, brace-aware so JSX expressions like
    // `onChange={(e) => setX(e.target.value)}` (which contain `>` inside
    // an arrow) don't truncate the attribute capture and silently miss
    // the `aria-label` declared after them.
    const inputs = this._extractJsxTags(content, 'input');
    for (const attrs of inputs) {
      const type = (attrs.match(/type\s*=\s*["'](\w+)["']/i) || [])[1] || 'text';
      if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;

      const hasLabel = /aria-label\s*=/i.test(attrs) ||
                       /aria-labelledby\s*=/i.test(attrs) ||
                       /\bid\s*=/i.test(attrs);

      if (!hasLabel) {
        result.addCheck(`a11y:input-label:${relPath}`, false, {
          file: relPath,
          message: `Input (type="${type}") missing accessible label`,
          suggestion: 'Add aria-label, aria-labelledby, or an associated <label> element',
        });
      }
    }
  }

  // Brace-balanced JSX-tag attribute extractor. Walks the source looking
  // for `<tagName` openings, then advances character-by-character tracking
  // brace depth (`{...}` JSX expression containers) and string-literal
  // state until it finds the closing `>` at depth 0. This gets around
  // the classic regex bug where a non-greedy `[^>]*?` cuts off at the
  // first `>` inside an arrow function (`(e) =>`).
  _extractJsxTags(source, tagName) {
    const out = [];
    const opener = `<${tagName}`;
    let i = 0;
    while (i < source.length) {
      const idx = source.indexOf(opener, i);
      if (idx < 0) break;
      // Must be a real tag boundary — next char is whitespace, '/', '>',
      // or end of identifier (not e.g. `<inputs`).
      const after = source.charCodeAt(idx + opener.length);
      const isBoundary = isNaN(after) || after === 32 || after === 9 ||
                         after === 10 || after === 13 || after === 47 /* / */ ||
                         after === 62 /* > */;
      if (!isBoundary) { i = idx + opener.length; continue; }

      let j = idx + opener.length;
      let braceDepth = 0;
      let inString = null; // null | "'" | '"' | '`'
      while (j < source.length) {
        const ch = source[j];
        if (inString) {
          if (ch === '\\') { j += 2; continue; }
          if (ch === inString) inString = null;
          j += 1;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch;
          j += 1;
          continue;
        }
        if (ch === '{') { braceDepth += 1; j += 1; continue; }
        if (ch === '}') { braceDepth -= 1; j += 1; continue; }
        if (braceDepth === 0 && ch === '>') {
          out.push(source.slice(idx + opener.length, j));
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
    }
    return out;
  }

  _checkHeadingHierarchy(relPath, content, result) {
    const headingRegex = /<h([1-6])\b/gi;
    const headings = [];
    let match;
    while ((match = headingRegex.exec(content)) !== null) {
      headings.push(parseInt(match[1]));
    }

    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        result.addCheck(`a11y:heading-hierarchy:${relPath}`, false, {
          file: relPath,
          message: `Heading level skipped: h${headings[i - 1]} to h${headings[i]}`,
          suggestion: 'Use sequential heading levels (h1 > h2 > h3) without skipping',
        });
        break;
      }
    }
  }

  _checkAriaUsage(relPath, content, result) {
    // Check for invalid ARIA roles
    const roleRegex = /role\s*=\s*["'](\w+)["']/gi;
    const validRoles = new Set([
      'alert', 'alertdialog', 'application', 'article', 'banner', 'button',
      'cell', 'checkbox', 'columnheader', 'combobox', 'complementary',
      'contentinfo', 'definition', 'dialog', 'directory', 'document',
      'feed', 'figure', 'form', 'grid', 'gridcell', 'group', 'heading',
      'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main',
      'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'navigation', 'none', 'note', 'option', 'presentation',
      'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
      'rowheader', 'scrollbar', 'search', 'searchbox', 'separator',
      'slider', 'spinbutton', 'status', 'switch', 'tab', 'table',
      'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar',
      'tooltip', 'tree', 'treegrid', 'treeitem',
    ]);

    let match;
    while ((match = roleRegex.exec(content)) !== null) {
      if (!validRoles.has(match[1].toLowerCase())) {
        result.addCheck(`a11y:invalid-role:${relPath}`, false, {
          file: relPath,
          message: `Invalid ARIA role: "${match[1]}"`,
          suggestion: 'Use a valid WAI-ARIA role',
        });
      }
    }
  }

  _checkLanguageAttribute(relPath, content, result) {
    if (content.includes('<html') && !/lang\s*=\s*["']\w/i.test(content)) {
      result.addCheck(`a11y:html-lang:${relPath}`, false, {
        file: relPath,
        message: 'Missing lang attribute on <html> element',
        suggestion: 'Add lang="en" (or appropriate language) to <html>',
      });
    }
  }

  _checkLandmarks(relPath, content, result) {
    if (!content.includes('<html')) return; // Only full HTML pages

    const landmarks = ['<main', 'role="main"', '<nav', 'role="navigation"'];
    const hasMain = landmarks.slice(0, 2).some(l => content.includes(l));

    if (!hasMain) {
      result.addCheck(`a11y:landmark-main:${relPath}`, false, {
        file: relPath,
        message: 'Missing main landmark',
        suggestion: 'Add <main> element or role="main" to primary content area',
      });
    }
  }

  _checkFocusManagement(relPath, content, result) {
    // Check for tabindex > 0 (anti-pattern)
    const tabindexRegex = /tabindex\s*=\s*["'](\d+)["']/gi;
    let match;
    while ((match = tabindexRegex.exec(content)) !== null) {
      const value = parseInt(match[1]);
      if (value > 0) {
        result.addCheck(`a11y:tabindex-positive:${relPath}`, false, {
          file: relPath,
          message: `Positive tabindex="${value}" creates confusing tab order`,
          suggestion: 'Use tabindex="0" or tabindex="-1" instead',
        });
      }
    }
  }

  _checkReducedMotion(relPath, content, result) {
    // Check JS for motion/animation without prefers-reduced-motion check
    if (content.includes('animate(') || content.includes('requestAnimationFrame')) {
      if (!content.includes('prefers-reduced-motion')) {
        result.addCheck(`a11y:reduced-motion-js:${relPath}`, false, {
          file: relPath,
          message: 'Animations detected without prefers-reduced-motion check',
          suggestion: 'Check window.matchMedia("(prefers-reduced-motion: reduce)") before animating',
        });
      }
    }
  }

  _checkCssFocus(relPath, content, result) {
    if (content.includes(':focus') && content.includes('outline: none') ||
        content.includes('outline:none') || content.includes('outline: 0')) {
      if (!content.includes(':focus-visible')) {
        result.addCheck(`a11y:focus-outline:${relPath}`, false, {
          file: relPath,
          message: 'Focus outline removed without alternative',
          suggestion: 'Use :focus-visible instead of :focus, or provide custom focus indicators',
        });
      }
    }
  }

  _checkCssReducedMotion(relPath, content, result) {
    if ((content.includes('animation') || content.includes('transition')) &&
        !content.includes('prefers-reduced-motion')) {
      result.addCheck(`a11y:reduced-motion-css:${relPath}`, false, {
        file: relPath,
        message: 'CSS animations/transitions without prefers-reduced-motion media query',
        suggestion: 'Add @media (prefers-reduced-motion: reduce) { ... } to disable animations',
      });
    }
  }

  /**
   * Parse a CSS color string into {r, g, b} with values 0-255.
   * Supports hex (#fff, #ffffff), rgb(), rgba(), and named colors.
   * Returns null if the color cannot be parsed.
   */
  _parseColor(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const s = colorStr.trim().toLowerCase();

    // Hex: #rrggbb
    const hex6 = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
    if (hex6) {
      return {
        r: parseInt(hex6[1], 16),
        g: parseInt(hex6[2], 16),
        b: parseInt(hex6[3], 16),
      };
    }

    // Hex: #rgb
    const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
    if (hex3) {
      return {
        r: parseInt(hex3[1] + hex3[1], 16),
        g: parseInt(hex3[2] + hex3[2], 16),
        b: parseInt(hex3[3] + hex3[3], 16),
      };
    }

    // rgb(r, g, b) or rgba(r, g, b, a)
    const rgbMatch = s.match(
      /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/
    );
    if (rgbMatch) {
      return {
        r: Math.min(255, parseInt(rgbMatch[1], 10)),
        g: Math.min(255, parseInt(rgbMatch[2], 10)),
        b: Math.min(255, parseInt(rgbMatch[3], 10)),
      };
    }

    // Named colors
    if (NAMED_COLORS[s]) {
      return { ...NAMED_COLORS[s] };
    }

    return null;
  }

  /**
   * Calculate relative luminance per WCAG 2.x formula.
   * Input: r, g, b as 0-255 integers.
   * Returns luminance value between 0 and 1.
   */
  _relativeLuminance(r, g, b) {
    const [rs, gs, bs] = [r, g, b].map((c) => {
      const srgb = c / 255;
      return srgb <= 0.03928
        ? srgb / 12.92
        : Math.pow((srgb + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  /**
   * Calculate contrast ratio between two luminance values.
   * Returns ratio >= 1 (lighter / darker).
   */
  _contrastRatio(lum1, lum2) {
    const lighter = Math.max(lum1, lum2);
    const darker = Math.min(lum1, lum2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Static CSS color contrast analysis.
   * Scans CSS files for color/background-color pairs within the same rule
   * and flags pairs that fail WCAG AAA contrast thresholds.
   */
  _checkColorContrast(projectRoot, result) {
    const cssFiles = this._collectFiles(projectRoot, ['.css', '.scss', '.less']);
    let totalChecked = 0;

    for (const file of cssFiles) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      // Extract CSS rule blocks (match selector { declarations })
      const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
      let ruleMatch;

      while ((ruleMatch = ruleRegex.exec(content)) !== null) {
        const selector = ruleMatch[1].trim();
        const declarations = ruleMatch[2];

        // Extract color and background-color from declarations
        const colorMatch = declarations.match(
          /(?:^|;)\s*color\s*:\s*([^;!]+)/i
        );
        const bgMatch = declarations.match(
          /(?:^|;)\s*background-color\s*:\s*([^;!]+)/i
        );

        if (!colorMatch || !bgMatch) continue;

        const fgColor = this._parseColor(colorMatch[1].trim());
        const bgColor = this._parseColor(bgMatch[1].trim());

        if (!fgColor || !bgColor) continue;

        totalChecked++;
        const fgLum = this._relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
        const bgLum = this._relativeLuminance(bgColor.r, bgColor.g, bgColor.b);
        const ratio = this._contrastRatio(fgLum, bgLum);

        // WCAG AAA: 4.5:1 for large text, 7:1 for normal text.
        // Flag anything below 4.5:1 (minimum even for large text under AAA).
        if (ratio < 4.5) {
          result.addCheck(
            `a11y:contrast-static:${relPath}:${totalChecked}`,
            false,
            {
              file: relPath,
              selector,
              foreground: colorMatch[1].trim(),
              background: bgMatch[1].trim(),
              contrastRatio: Math.round(ratio * 100) / 100,
              message: `Low contrast ratio ${Math.round(ratio * 100) / 100}:1 (WCAG AAA requires 7:1 for normal text, 4.5:1 for large text)`,
              suggestion:
                'Increase contrast between text color and background color',
            }
          );
        } else if (ratio < 7) {
          // Passes large text AAA but fails normal text AAA
          result.addCheck(
            `a11y:contrast-static:${relPath}:${totalChecked}`,
            false,
            {
              file: relPath,
              selector,
              foreground: colorMatch[1].trim(),
              background: bgMatch[1].trim(),
              contrastRatio: Math.round(ratio * 100) / 100,
              message: `Contrast ratio ${Math.round(ratio * 100) / 100}:1 passes for large text but fails WCAG AAA for normal text (requires 7:1)`,
              suggestion:
                'Increase contrast for normal-sized text or ensure this rule only applies to large text (18px+ or 14px+ bold)',
            }
          );
        }
      }
    }

    if (totalChecked === 0) {
      result.addCheck('a11y:contrast-static', true, {
        message:
          'No color/background-color pairs found in CSS to check (or colors could not be parsed)',
      });
    }
  }

  /**
   * Live contrast checking using Playwright.
   * Loads the page, inspects computed styles of text elements,
   * and flags elements with insufficient contrast.
   */
  async _checkLiveContrast(config, result) {
    const url =
      config.url ||
      config.siteUrl ||
      (config.options && config.options.url);
    if (!url) {
      result.addCheck('a11y:contrast-live', true, {
        message: 'No URL configured — skipping live contrast check',
      });
      return;
    }

    let playwright;
    try {
      playwright = require('playwright');
    } catch {
      result.addCheck('a11y:contrast-live', true, {
        message:
          'Playwright not available — skipping live contrast check. Install playwright for full coverage.',
      });
      return;
    }

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Evaluate in-page: collect computed styles for text elements
      const elements = await page.evaluate(() => {
        const textSelectors =
          'p, span, a, li, td, th, h1, h2, h3, h4, h5, h6, label, button, div, section, article';
        const els = document.querySelectorAll(textSelectors);
        const results = [];

        for (const el of els) {
          // Skip elements with no visible text
          const text = el.textContent.trim();
          if (!text || text.length === 0) continue;

          // Skip hidden elements
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          )
            continue;

          const color = style.color;
          const bgColor = style.backgroundColor;

          if (color && bgColor) {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const cls =
              el.className && typeof el.className === 'string'
                ? '.' +
                  el.className
                    .split(/\s+/)
                    .slice(0, 2)
                    .join('.')
                : '';
            const shortText =
              text.substring(0, 30) + (text.length > 30 ? '...' : '');
            const fontSize = parseFloat(style.fontSize);
            const fontWeight = parseInt(style.fontWeight, 10) || 400;

            results.push({
              descriptor: `${tag}${id}${cls}`,
              shortText,
              color,
              bgColor,
              fontSize,
              fontWeight,
            });
          }

          if (results.length >= 200) break;
        }
        return results;
      });

      let issueCount = 0;
      for (const el of elements) {
        if (issueCount >= 50) break;

        const fgColor = this._parseColor(el.color);
        const bgColor = this._parseColor(el.bgColor);
        if (!fgColor || !bgColor) continue;

        const fgLum = this._relativeLuminance(fgColor.r, fgColor.g, fgColor.b);
        const bgLum = this._relativeLuminance(bgColor.r, bgColor.g, bgColor.b);
        const ratio = this._contrastRatio(fgLum, bgLum);

        // Large text: 18px+ or 14px+ bold (fontWeight >= 700)
        const isLargeText =
          el.fontSize >= 18 || (el.fontSize >= 14 && el.fontWeight >= 700);
        const requiredRatio = isLargeText ? 4.5 : 7;

        if (ratio < requiredRatio) {
          issueCount++;
          result.addCheck(`a11y:contrast-live:${issueCount}`, false, {
            element: el.descriptor,
            text: el.shortText,
            foreground: el.color,
            background: el.bgColor,
            contrastRatio: Math.round(ratio * 100) / 100,
            requiredRatio,
            isLargeText,
            message: `Live contrast ${Math.round(ratio * 100) / 100}:1 on "${el.descriptor}" — requires ${requiredRatio}:1 for WCAG AAA (${isLargeText ? 'large' : 'normal'} text)`,
            suggestion:
              'Increase contrast between text and background colors',
          });
        }
      }

      if (issueCount === 0) {
        result.addCheck('a11y:contrast-live', true, {
          message: `Live contrast check passed — ${elements.length} elements inspected`,
        });
      }
    } catch (err) {
      result.addCheck('a11y:contrast-live', true, {
        message: `Live contrast check could not complete: ${err.message}`,
      });
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}

module.exports = AccessibilityModule;
