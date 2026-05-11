/**
 * Go module — ignored errors, fmt.Println in libraries, panics, goroutines.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class GoModule extends BaseModule {
  constructor() { super('go', 'Go Checks — ignored errors, panics, goroutine hygiene'); }
  async run(result, config) {
    runLanguageChecks('go', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = GoModule;
