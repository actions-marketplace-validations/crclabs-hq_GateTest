/**
 * Python module — pattern-based checks for eval/exec, bare-except,
 * mutable defaults, SQL concatenation, pickle loads, etc.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class PythonModule extends BaseModule {
  constructor() { super('python', 'Python Checks — eval/exec, bare-except, SQL injection, pickle'); }
  async run(result, config) {
    runLanguageChecks('python', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = PythonModule;
