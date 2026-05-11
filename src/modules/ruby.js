/**
 * Ruby module — eval of strings, shell interpolation, bare rescues, puts.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class RubyModule extends BaseModule {
  constructor() { super('ruby', 'Ruby Checks — eval, shell injection, bare rescue'); }
  async run(result, config) {
    runLanguageChecks('ruby', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = RubyModule;
