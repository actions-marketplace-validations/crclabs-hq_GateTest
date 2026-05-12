/**
 * Kotlin module — !! not-null assertions, TODO(), println.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class KotlinModule extends BaseModule {
  constructor() { super('kotlin', 'Kotlin Checks — !!, TODO(), println'); }
  async run(result, config) {
    runLanguageChecks('kotlin', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = KotlinModule;
