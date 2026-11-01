'use strict';
/*
 * FUTURE EXTENSION POINT — nothing here is connected to any route, screen or button.
 *
 * AI features (app generation, chat, automatic error fixing) are NOT part of this version.
 * When they are added, they should plug in here and only produce what the rest of the app
 * already understands:
 *
 *   generator.generate(request) -> { name, config }      // same shape as project.config
 *
 * The rest of the pipeline (saving, previewing, building) stays unchanged:
 *   project.config --> lib/android.js buildSpec() --> cloud build --> APK
 *
 * Projects already carry a `source` field ("manual" today) so you can later tell
 * hand-made projects from generated ones.
 */

const generators = new Map();

function registerGenerator(name, implementation) {
  if (typeof implementation.generate !== 'function') throw new Error('A generator needs a generate() function.');
  generators.set(name, implementation);
}

function getGenerator(name) {
  return generators.get(name) || null;
}

module.exports = { registerGenerator, getGenerator, AI_ENABLED: false };
