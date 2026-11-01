#!/usr/bin/env node
'use strict';
// Used by the GitHub Actions workflow (and usable by hand):
//   node scripts/prepare-android.js builds/<build-id>.json out/android
// Reads a build description and writes a complete Android project into the output folder.
const fs = require('fs');
const path = require('path');
const { generateAndroidFiles, validateSpec } = require('../lib/android');

function main() {
  const [specFile, outDir] = process.argv.slice(2);
  if (!specFile || !outDir) {
    console.error('Usage: node scripts/prepare-android.js <build-file.json> <output-folder>');
    process.exit(2);
  }
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  } catch (err) {
    console.error(`ERROR: Could not read the build file "${specFile}": ${err.message}`);
    process.exit(1);
  }
  const problems = validateSpec(spec);
  if (problems.length) {
    console.error('ERROR: The build description is not valid: ' + problems.join(' '));
    process.exit(1);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  const files = generateAndroidFiles(spec);
  for (const f of files) {
    const target = path.join(outDir, f.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
  console.log(`Prepared Android project "${spec.appName}" (${spec.packageName}) with ${files.length} files in ${outDir}`);
}

main();
