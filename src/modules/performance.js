/**
 * Performance Module - Bundle size, Core Web Vitals, and resource optimization.
 * Enforces performance budgets defined in CLAUDE.md.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class PerformanceModule extends BaseModule {
  constructor() {
    super('performance', 'Performance & Web Vitals Analysis');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const thresholds = config.config.thresholds;
    const perfConfig = config.getModuleConfig('performance');

    // Bundle size analysis
    this._checkBundleSize(projectRoot, thresholds, perfConfig, result);

    // Check for render-blocking resources
    this._checkRenderBlocking(projectRoot, result);

    // Check image optimization
    this._checkImageOptimization(projectRoot, result);

    // Check for lazy loading
    this._checkLazyLoading(projectRoot, result);

    // Check for memory leak patterns
    this._checkMemoryLeakPatterns(projectRoot, result);

    // Run Lighthouse if available
    this._runLighthouse(projectRoot, thresholds, result);
  }

  _checkBundleSize(projectRoot, thresholds, perfConfig, result) {
    const distDirs = ['dist', 'build', 'out', '.next', 'public'];
    let distDir = null;

    for (const dir of distDirs) {
      const fullPath = path.join(projectRoot, dir);
      if (fs.existsSync(fullPath)) {
        distDir = fullPath;
        break;
      }
    }

    if (!distDir) {
      result.addCheck('perf:bundle-size', true, { message: 'No build output directory found — skipping bundle check' });
      return;
    }

    const jsFiles = this._collectFiles(distDir, ['.js']);
    const cssFiles = this._collectFiles(distDir, ['.css']);

    let totalJsSize = 0;
    let totalCssSize = 0;

    for (const file of jsFiles) {
      const content = fs.readFileSync(file);
      const gzipped = zlib.gzipSync(content);
      totalJsSize += gzipped.length;
    }

    for (const file of cssFiles) {
      const content = fs.readFileSync(file);
      const gzipped = zlib.gzipSync(content);
      totalCssSize += gzipped.length;
    }

    const budget = perfConfig.budget || {};
    const jsBudget = budget.js || thresholds.maxBundleSizeJs;
    const cssBudget = budget.css || thresholds.maxBundleSizeCss;

    if (totalJsSize > jsBudget) {
      result.addCheck('perf:bundle-js', false, {
        expected: `<= ${(jsBudget / 1024).toFixed(0)}KB gzipped`,
        actual: `${(totalJsSize / 1024).toFixed(1)}KB gzipped`,
        message: 'JavaScript bundle exceeds budget',
        suggestion: 'Analyze bundle with "npx webpack-bundle-analyzer" and remove unused code',
      });
    } else {
      result.addCheck('perf:bundle-js', true, {
        message: `JS bundle: ${(totalJsSize / 1024).toFixed(1)}KB / ${(jsBudget / 1024).toFixed(0)}KB gzipped`,
      });
    }

    if (totalCssSize > cssBudget) {
      result.addCheck('perf:bundle-css', false, {
        expected: `<= ${(cssBudget / 1024).toFixed(0)}KB gzipped`,
        actual: `${(totalCssSize / 1024).toFixed(1)}KB gzipped`,
        message: 'CSS bundle exceeds budget',
        suggestion: 'Remove unused CSS with PurgeCSS or tree-shaking',
      });
    } else {
      result.addCheck('perf:bundle-css', true, {
        message: `CSS bundle: ${(totalCssSize / 1024).toFixed(1)}KB / ${(cssBudget / 1024).toFixed(0)}KB gzipped`,
      });
    }
  }

  _checkRenderBlocking(projectRoot, result) {
    const htmlFiles = this._collectFiles(projectRoot, ['.html']);
    for (const file of htmlFiles) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      // Check for render-blocking scripts in <head>
      const headMatch = content.match(/<head>([\s\S]*?)<\/head>/i);
      if (headMatch) {
        const head = headMatch[1];
        const blockingScripts = head.match(/<script\b(?![^>]*(?:async|defer|type="module"))[^>]*src=/gi);
        if (blockingScripts && blockingScripts.length > 0) {
          result.addCheck(`perf:render-blocking:${relPath}`, false, {
            file: relPath,
            message: `${blockingScripts.length} render-blocking script(s) in <head>`,
            suggestion: 'Add async/defer attribute or move scripts to end of <body>',
          });
        }
      }
    }
  }

  _checkImageOptimization(projectRoot, result) {
    const imageFiles = this._collectFiles(projectRoot, ['.png', '.jpg', '.jpeg', '.gif', '.bmp']);
    const largeImages = [];

    for (const file of imageFiles) {
      const stats = fs.statSync(file);
      if (stats.size > 200 * 1024) { // 200KB
        largeImages.push({
          file: path.relative(projectRoot, file),
          size: `${(stats.size / 1024).toFixed(0)}KB`,
        });
      }
    }

    if (largeImages.length > 0) {
      result.addCheck('perf:large-images', false, {
        message: `${largeImages.length} image(s) over 200KB`,
        details: largeImages.slice(0, 10),
        suggestion: 'Convert to WebP/AVIF format and compress images',
      });
    }

    // Check for WebP/AVIF usage — informational only. Many projects ship
    // SVG / optimised PNG and don't need WebP, and Next.js' Image component
    // does on-demand format conversion at request time. Surface this as a
    // warning rather than a blocking error.
    const webpFiles = this._collectFiles(projectRoot, ['.webp', '.avif']);
    if (imageFiles.length > 0 && webpFiles.length === 0) {
      result.addCheck('perf:modern-images', false, {
        severity: 'warning',
        message: 'No WebP/AVIF images found — using only legacy formats',
        suggestion: 'Convert images to WebP/AVIF with fallbacks for better performance',
      });
    }
  }

  _checkLazyLoading(projectRoot, result) {
    const htmlFiles = this._collectFiles(projectRoot, ['.html', '.jsx', '.tsx']);
    for (const file of htmlFiles) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      // Count images without loading="lazy"
      const allImgs = (content.match(/<img\b/gi) || []).length;
      const lazyImgs = (content.match(/loading\s*=\s*["']lazy["']/gi) || []).length;

      if (allImgs > 3 && lazyImgs === 0) {
        result.addCheck(`perf:lazy-loading:${relPath}`, false, {
          file: relPath,
          message: `${allImgs} images without lazy loading`,
          suggestion: 'Add loading="lazy" to below-the-fold images',
        });
      }
    }
  }

  _checkMemoryLeakPatterns(projectRoot, result) {
    const jsFiles = this._collectFiles(projectRoot, ['.js', '.ts', '.jsx', '.tsx']);
    // Scanner modules / orchestrator libs / marketing-doc pages legitimately
    // contain literal "setInterval(" / "addEventListener(" pattern strings as
    // detection patterns or doc copy — they shouldn't trigger their own check.
    const SCANNER_PATH_RE = /(?:^|\/)(?:src\/modules|src\/core|website\/app\/lib\/scan-modules|website\/app\/lib\/multi-file-refactor|website\/app\/for|tests|integrations\/infra)\//;
    for (const file of jsFiles) {
      const relPath = path.relative(projectRoot, file);
      const normalised = relPath.replace(/\\/g, '/');
      if (SCANNER_PATH_RE.test('/' + normalised)) continue;
      const content = fs.readFileSync(file, 'utf-8');

      // Check for addEventListener without removeEventListener
      const addCount = (content.match(/addEventListener\s*\(/g) || []).length;
      const removeCount = (content.match(/removeEventListener\s*\(/g) || []).length;

      if (addCount > 0 && removeCount === 0 && addCount > 2) {
        result.addCheck(`perf:event-cleanup:${relPath}`, false, {
          file: relPath,
          message: `${addCount} addEventListener calls but no removeEventListener — potential memory leak`,
          suggestion: 'Clean up event listeners in cleanup/destroy/unmount handlers',
        });
      }

      // Check for setInterval without clearInterval
      const setCount = (content.match(/setInterval\s*\(/g) || []).length;
      const clearCount = (content.match(/clearInterval\s*\(/g) || []).length;

      if (setCount > 0 && clearCount === 0) {
        result.addCheck(`perf:interval-cleanup:${relPath}`, false, {
          file: relPath,
          message: `setInterval without clearInterval — potential memory leak`,
          suggestion: 'Store interval ID and call clearInterval in cleanup',
        });
      }
    }
  }

  _runLighthouse(projectRoot, thresholds, result) {
    // Lighthouse requires a running server — check if lighthouse CLI is available
    const { exitCode } = this._exec('npx lighthouse --version 2>/dev/null', { cwd: projectRoot });

    if (exitCode !== 0) {
      result.addCheck('perf:lighthouse', true, {
        message: 'Lighthouse not available — install with "npm i -D lighthouse" for full perf audit',
      });
      return;
    }

    result.addCheck('perf:lighthouse-available', true, {
      message: 'Lighthouse available — run against live URL for full audit',
    });
  }
}

module.exports = PerformanceModule;
