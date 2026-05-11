/**
 * Java module — System.out, broad Exception catches, empty catches,
 * printStackTrace usage.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class JavaModule extends BaseModule {
  constructor() { super('java', 'Java Checks — System.out, broad catches, empty catches'); }
  async run(result, config) {
    runLanguageChecks('java', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = JavaModule;
