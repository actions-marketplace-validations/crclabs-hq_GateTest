/**
 * C# module — Console.WriteLine in libraries, empty/broad catches.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class CSharpModule extends BaseModule {
  constructor() { super('csharp', 'C# Checks — Console.WriteLine, empty catches'); }
  async run(result, config) {
    runLanguageChecks('csharp', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = CSharpModule;
