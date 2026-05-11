/**
 * Rust module — unwrap(), panic!, todo!, unimplemented!, unsafe blocks.
 * See src/core/universal-checker.js for pattern definitions.
 */
const BaseModule = require('./base-module');
const { runLanguageChecks } = require('../core/universal-checker');

class RustModule extends BaseModule {
  constructor() { super('rust', 'Rust Checks — unwrap/panic/todo, unsafe block review'); }
  async run(result, config) {
    runLanguageChecks('rust', config.projectRoot, result, {
      incrementalFiles: config._incrementalFiles,
    });
  }
}

module.exports = RustModule;
