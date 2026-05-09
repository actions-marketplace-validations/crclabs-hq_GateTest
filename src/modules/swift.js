/**
 * Swift module — fatalError, try!, force-unwrap, print in libraries.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class SwiftModule extends BaseModule {
  constructor() { super('swift', 'Swift Checks — fatalError, try!, force-unwrap'); }
  async run(result, config) {
    runLanguageChecks('swift', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = SwiftModule;
