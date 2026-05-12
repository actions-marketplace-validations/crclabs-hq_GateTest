/**
 * PHP module — eval, legacy mysql_*, unescaped superglobals, var_dump.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class PhpModule extends BaseModule {
  constructor() { super('php', 'PHP Checks — eval, legacy mysql_, XSS, debug output'); }
  async run(result, config) {
    runLanguageChecks('php', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = PhpModule;
