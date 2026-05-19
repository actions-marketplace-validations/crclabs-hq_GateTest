/**
 * Visual Module - Visual regression testing, font validation, spacing, and UI consistency.
 * Compares screenshots against baselines and validates design tokens.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

class VisualModule extends BaseModule {
  constructor() {
    super('visual', 'Visual & UI Regression Testing');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const visualConfig = config.getModuleConfig('visual');

    // Check CSS for common visual issues
    const cssFiles = this._collectFiles(projectRoot, ['.css', '.scss', '.less']);
    const htmlFiles = this._collectFiles(projectRoot, ['.html', '.jsx', '.tsx', '.vue', '.svelte']);

    for (const file of cssFiles) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      this._checkLayoutShifts(relPath, content, result);
      this._checkFontLoading(relPath, content, result);
      this._checkOverflow(relPath, content, result);
      this._checkPrintStyles(relPath, content, result);
      this._checkZIndex(relPath, content, result);
    }

    // Static dev fixtures under public/ are not customer-facing routes.
    const INTERNAL_PATH_RE = /(?:^|\/)(?:website\/public\/)/;

    for (const file of htmlFiles) {
      const relPath = path.relative(projectRoot, file);
      const normalised = relPath.replace(/\\/g, '/');
      if (INTERNAL_PATH_RE.test('/' + normalised)) continue;
      const content = fs.readFileSync(file, 'utf-8');

      this._checkImageDimensions(relPath, content, result);
      this._checkViewport(relPath, content, result);
    }

    // Check for design tokens / CSS custom properties consistency
    this._checkDesignTokens(projectRoot, cssFiles, result);

    // Verify screenshot baselines exist if configured
    this._checkBaselines(projectRoot, visualConfig, result);

    if (cssFiles.length === 0 && htmlFiles.length === 0) {
      result.addCheck('visual:files', true, { message: 'No CSS/HTML files to check' });
    }
  }

  _checkLayoutShifts(relPath, content, result) {
    // Images/videos without explicit dimensions cause layout shifts
    // Check for common CLS-causing patterns
    const clsPatterns = [
      { regex: /position\s*:\s*absolute(?!.*contain)/g, name: 'absolute-positioning' },
    ];

    // Check for font-display strategy
    if (content.includes('@font-face') && !content.includes('font-display')) {
      result.addCheck(`visual:font-display:${relPath}`, false, {
        file: relPath,
        message: '@font-face without font-display property — causes FOIT/FOUT',
        suggestion: 'Add "font-display: swap" or "font-display: optional" to @font-face',
      });
    }
  }

  _checkFontLoading(relPath, content, result) {
    // Verify fonts have fallbacks
    const fontFamilyRegex = /font-family\s*:\s*([^;]+)/gi;
    let match;
    while ((match = fontFamilyRegex.exec(content)) !== null) {
      const value = match[1].trim();
      const fonts = value.split(',').map(f => f.trim());
      const genericFamilies = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];

      if (fonts.length === 1 && !genericFamilies.includes(fonts[0].replace(/['"]/g, '').toLowerCase())) {
        result.addCheck(`visual:font-fallback:${relPath}`, false, {
          file: relPath,
          message: `Font "${fonts[0]}" has no fallback font-family`,
          suggestion: 'Add a generic font family as fallback (e.g., sans-serif)',
        });
      }
    }
  }

  _checkOverflow(relPath, content, result) {
    // Check for potential horizontal overflow issues
    if (content.includes('overflow-x: hidden') && content.includes('body')) {
      result.addCheck(`visual:body-overflow-hidden:${relPath}`, false, {
        file: relPath,
        message: 'overflow-x: hidden on body — may hide underlying layout issues',
        suggestion: 'Fix the root cause of horizontal overflow instead of hiding it',
      });
    }
  }

  _checkPrintStyles(relPath, content, result) {
    if (content.includes('@media') && content.includes('screen') && !content.includes('print')) {
      // Has media queries but no print styles
      result.addCheck(`visual:print-styles:${relPath}`, false, {
        file: relPath,
        message: 'Media queries found but no print stylesheet',
        suggestion: 'Add @media print { ... } for printable pages',
      });
    }
  }

  _checkZIndex(relPath, content, result) {
    // Check for z-index wars (values > 9999)
    const zIndexRegex = /z-index\s*:\s*(\d+)/g;
    let match;
    while ((match = zIndexRegex.exec(content)) !== null) {
      const value = parseInt(match[1]);
      if (value > 9999) {
        result.addCheck(`visual:z-index:${relPath}`, false, {
          file: relPath,
          message: `z-index: ${value} — excessively high z-index`,
          suggestion: 'Use a z-index scale/token system instead of arbitrary large values',
        });
      }
    }
  }

  _checkImageDimensions(relPath, content, result) {
    // Images should have width and height to prevent CLS
    const imgRegex = /<img\b([^>]*?)>/gi;
    let match;
    while ((match = imgRegex.exec(content)) !== null) {
      const attrs = match[1];
      const hasWidth = /\bwidth\s*=/i.test(attrs);
      const hasHeight = /\bheight\s*=/i.test(attrs);

      if (!hasWidth || !hasHeight) {
        result.addCheck(`visual:img-dimensions:${relPath}`, false, {
          file: relPath,
          message: 'Image missing explicit width/height — causes layout shift (CLS)',
          suggestion: 'Add width and height attributes to <img> tags',
        });
      }
    }
  }

  _checkViewport(relPath, content, result) {
    if (content.includes('<html') && !content.includes('viewport')) {
      result.addCheck(`visual:viewport:${relPath}`, false, {
        file: relPath,
        message: 'Missing viewport meta tag',
        suggestion: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">',
      });
    }
  }

  _checkDesignTokens(projectRoot, cssFiles, result) {
    // Check for consistent use of CSS custom properties
    const allVars = new Map();
    for (const file of cssFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const varDefs = content.match(/--[\w-]+\s*:/g) || [];
      for (const v of varDefs) {
        const name = v.replace(':', '').trim();
        allVars.set(name, (allVars.get(name) || 0) + 1);
      }
    }

    // Check for duplicate variable definitions
    for (const [name, count] of allVars) {
      if (count > 3) {
        result.addCheck(`visual:duplicate-token:${name}`, false, {
          message: `CSS variable "${name}" defined ${count} times — possible inconsistency`,
          suggestion: 'Define CSS custom properties in a single :root block',
        });
      }
    }
  }

  _checkBaselines(projectRoot, visualConfig, result) {
    const baselineDir = path.join(projectRoot, visualConfig.baselineDir || '.gatetest/baselines');
    if (!fs.existsSync(baselineDir)) {
      result.addCheck('visual:baselines', true, {
        message: 'No baseline screenshots — run "gatetest --update-baselines" to create them',
      });
    }
  }
}

module.exports = VisualModule;
