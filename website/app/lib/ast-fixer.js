/**
 * AST-based code fixer for JS/TS/JSX/TSX files.
 *
 * Uses @babel/parser + @babel/traverse + @babel/generator (available as
 * transitive dependencies of Next.js — no new package.json entries needed).
 *
 * Advantage over regex: handles multiline expressions, nested objects,
 * destructuring, template literals, and all valid JS/TS syntax variations.
 *
 * Public API:
 *   tryAstFix(content, filePath, issues) → string|null
 *     Returns the fully-fixed content if ALL issues were handled, or null
 *     to signal the caller should fall through to the next fixer or Claude.
 *
 *   applyAstTransforms(content, filePath, issues) → { content, handled, unhandled }
 *     Partial-application form used internally and in tests.
 */

let _parser, _traverse, _generate;

function getBabel() {
  if (!_parser) {
    // Available as Next.js transitive deps — no new package.json entry needed.
    // Lazy-load so the module can be required without Babel installed (tests skip).
    _parser = require('@babel/parser');
    _traverse = require('@babel/traverse').default;
    _generate = require('@babel/generator').default;
  }
  return { parser: _parser, traverse: _traverse, generate: _generate };
}

// ---------------------------------------------------------------------------
// Supported extensions
// ---------------------------------------------------------------------------

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

function isJsOrTs(filePath) {
  if (!filePath) return false;
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return JS_EXTENSIONS.has(ext);
}

function isTypeScript(filePath) {
  if (!filePath) return false;
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts';
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

function parseCode(content, filePath) {
  const { parser } = getBabel();
  const plugins = ['optionalChaining', 'nullishCoalescingOperator', 'classProperties', 'decorators-legacy'];
  if (isTypeScript(filePath)) {
    plugins.push('typescript');
  } else {
    plugins.push('jsx');
  }
  if (filePath && (filePath.endsWith('.tsx') || filePath.endsWith('.jsx'))) {
    if (!plugins.includes('jsx')) plugins.push('jsx');
  }
  return parser.parse(content, {
    sourceType: 'unambiguous',
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    plugins,
  });
}

function generateCode(ast, originalContent) {
  const { generate } = getBabel();
  const result = generate(ast, {
    retainLines: false,
    compact: false,
    concise: false,
    jsescOption: { minimal: true },
  }, originalContent);
  return result.code;
}

// ---------------------------------------------------------------------------
// AST transform definitions
//
// Each transform:
//   name       — identifier
//   matches    — (issueStr) => bool: does this issue string apply?
//   transform  — (ast, traverse, issueStr) => number of nodes changed
// ---------------------------------------------------------------------------

const TRANSFORMS = [
  // --- TLS / cert validation -----------------------------------------------

  {
    name: 'ast-reject-unauthorized',
    matches: (issue) => /rejectUnauthorized/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      traverse(ast, {
        ObjectProperty(path) {
          if (getKeyName(path.node) === 'rejectUnauthorized' &&
              isBooleanLiteral(path.node.value, false)) {
            path.node.value.value = true;
            changed++;
          }
        },
      });
      return changed;
    },
  },

  {
    name: 'ast-strict-ssl',
    matches: (issue) => /strictSSL/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      traverse(ast, {
        ObjectProperty(path) {
          if (getKeyName(path.node) === 'strictSSL' &&
              isBooleanLiteral(path.node.value, false)) {
            path.node.value.value = true;
            changed++;
          }
        },
      });
      return changed;
    },
  },

  {
    name: 'ast-insecure-flag',
    matches: (issue) => /\binsecure\s*:\s*true\b/i.test(issue) || /js-insecure-flag/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      traverse(ast, {
        ObjectProperty(path) {
          if (getKeyName(path.node) === 'insecure' &&
              isBooleanLiteral(path.node.value, true)) {
            path.node.value.value = false;
            changed++;
          }
        },
      });
      return changed;
    },
  },

  {
    name: 'ast-tls-env-bypass',
    // process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0" — remove the statement
    matches: (issue) => /NODE_TLS_REJECT_UNAUTHORIZED/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      traverse(ast, {
        ExpressionStatement(path) {
          const expr = path.node.expression;
          if (
            expr.type === 'AssignmentExpression' &&
            expr.operator === '=' &&
            isTlsEnvLeft(expr.left) &&
            isStringLiteral(expr.right, '0')
          ) {
            path.remove();
            changed++;
          }
        },
      });
      return changed;
    },
  },

  // --- Cookie / session security -------------------------------------------

  {
    name: 'ast-httponly',
    matches: (issue) => /httpOnly\s*:\s*false/i.test(issue) || /js-httponly-false/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      traverse(ast, {
        ObjectProperty(path) {
          if (getKeyName(path.node) === 'httpOnly' &&
              isBooleanLiteral(path.node.value, false)) {
            path.node.value.value = true;
            changed++;
          }
        },
      });
      return changed;
    },
  },

  {
    name: 'ast-secure-cookie',
    matches: (issue) => /\bsecure\s*:\s*false\b/i.test(issue) || /js-secure-false/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      traverse(ast, {
        ObjectProperty(path) {
          if (getKeyName(path.node) === 'secure' &&
              isBooleanLiteral(path.node.value, false)) {
            path.node.value.value = true;
            changed++;
          }
        },
      });
      return changed;
    },
  },

  // --- parseInt radix -------------------------------------------------------

  {
    name: 'ast-parseint-radix',
    matches: (issue) => /parseInt.*radix/i.test(issue) || /missing.*radix/i.test(issue) || /parseInt.*without/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      const t = require('@babel/types');
      traverse(ast, {
        CallExpression(path) {
          const callee = path.node.callee;
          // Match parseInt(x) or window.parseInt(x) or globalThis.parseInt(x)
          const isParseInt =
            (callee.type === 'Identifier' && callee.name === 'parseInt') ||
            (callee.type === 'MemberExpression' &&
              callee.property.type === 'Identifier' &&
              callee.property.name === 'parseInt');
          if (isParseInt && path.node.arguments.length === 1) {
            path.node.arguments.push(t.numericLiteral(10));
            changed++;
          }
        },
      });
      return changed;
    },
  },

  // --- var → const ----------------------------------------------------------

  {
    name: 'ast-var-to-const',
    matches: (issue) => /\bvar\b.*decl/i.test(issue) || /prefer.*const/i.test(issue) || /use const.*let.*var/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      traverse(ast, {
        VariableDeclaration(path) {
          if (path.node.kind === 'var') {
            path.node.kind = 'const';
            changed++;
          }
        },
      });
      return changed;
    },
  },

  // --- Empty catch block — add rethrow ------------------------------------

  {
    name: 'ast-empty-catch',
    matches: (issue) => /empty\s+catch/i.test(issue) || /catch\s*\{\s*\}/i.test(issue) || /error-swallow/i.test(issue),
    transform(ast, traverse) {
      let changed = 0;
      const t = require('@babel/types');
      traverse(ast, {
        CatchClause(path) {
          const body = path.node.body;
          if (body.type === 'BlockStatement' && body.body.length === 0) {
            const param = path.node.param;
            if (param && param.type === 'Identifier') {
              // Add: throw err;
              body.body.push(t.throwStatement(t.identifier(param.name)));
            } else {
              // No param — add a comment explaining the intentional swallow
              // (we can't add a throw without the error variable)
              body.body.push(
                t.expressionStatement(
                  t.callExpression(
                    t.memberExpression(t.identifier('console'), t.identifier('error')),
                    [t.stringLiteral('Unhandled error')]
                  )
                )
              );
            }
            changed++;
          }
        },
      });
      return changed;
    },
  },
];

// ---------------------------------------------------------------------------
// AST node helpers
// ---------------------------------------------------------------------------

function getKeyName(node) {
  if (!node.key) return null;
  if (node.key.type === 'Identifier') return node.key.name;
  if (node.key.type === 'StringLiteral') return node.key.value;
  return null;
}

function isBooleanLiteral(node, value) {
  return node && node.type === 'BooleanLiteral' && node.value === value;
}

function isStringLiteral(node, value) {
  return node && node.type === 'StringLiteral' && node.value === value;
}

function isTlsEnvLeft(node) {
  // process.env.NODE_TLS_REJECT_UNAUTHORIZED
  // process.env["NODE_TLS_REJECT_UNAUTHORIZED"]
  if (node.type !== 'MemberExpression') return false;
  const obj = node.object;
  if (obj.type !== 'MemberExpression') return false;
  const isProcessEnv =
    obj.object.type === 'Identifier' && obj.object.name === 'process' &&
    obj.property.type === 'Identifier' && obj.property.name === 'env';
  if (!isProcessEnv) return false;
  const prop = node.property;
  return (prop.type === 'Identifier' && prop.name === 'NODE_TLS_REJECT_UNAUTHORIZED') ||
         (prop.type === 'StringLiteral' && prop.value === 'NODE_TLS_REJECT_UNAUTHORIZED');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply all matching AST transforms and return partial results.
 *
 * @param {string} content - JS/TS file content
 * @param {string} filePath - repo-relative path (used for plugin selection)
 * @param {string[]} issues
 * @returns {{ content: string, handled: string[], unhandled: string[] }}
 */
function applyAstTransforms(content, filePath, issues) {
  if (typeof content !== 'string') throw new TypeError('content must be a string');
  if (!Array.isArray(issues)) throw new TypeError('issues must be an array');
  if (!isJsOrTs(filePath)) {
    return { content, handled: [], unhandled: issues.slice() };
  }

  let ast;
  try {
    ast = parseCode(content, filePath);
  } catch {
    // Parse failure — fall through to Claude
    return { content, handled: [], unhandled: issues.slice() };
  }

  const { traverse } = getBabel();
  const handled = [];
  const unhandled = [];

  for (const issue of issues) {
    const transform = TRANSFORMS.find(t => t.matches(issue));
    if (!transform) {
      unhandled.push(issue);
      continue;
    }
    const count = transform.transform(ast, traverse, issue);
    if (count > 0) {
      handled.push(issue);
    } else {
      // Transform matched but made no changes — pattern may already be fixed
      // or the issue string doesn't reflect actual code in this file.
      // Check if a sibling transform already handled it (alreadyFixed semantics).
      unhandled.push(issue);
    }
  }

  if (handled.length === 0) {
    return { content, handled: [], unhandled };
  }

  let fixed;
  try {
    fixed = generateCode(ast, content);
  } catch {
    return { content, handled: [], unhandled: issues.slice() };
  }

  return { content: fixed, handled, unhandled };
}

/**
 * Try to fix ALL issues using AST transforms.
 *
 * Returns the fully-fixed content if every issue was handled, or null
 * to signal the caller should fall through to Claude.
 *
 * Only operates on JS/TS files; returns null immediately for Python etc.
 *
 * @param {string} content
 * @param {string} filePath
 * @param {string[]} issues
 * @returns {string|null}
 */
function tryAstFix(content, filePath, issues) {
  if (!issues || issues.length === 0) return null;
  if (!isJsOrTs(filePath)) return null;

  const result = applyAstTransforms(content, filePath, issues);
  if (result.unhandled.length > 0) return null;
  if (result.content === content) return null;
  return result.content;
}

module.exports = { tryAstFix, applyAstTransforms, TRANSFORMS, isJsOrTs };
