'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { generateAndroidFiles, validateSpec, makePackageName } = require('../lib/android');
const { createZip, readZip } = require('../lib/zip');
const { explainFailure, extractErrorLines } = require('../lib/explain');

const spec = { appName: "Joe's <App> & Co", packageName: 'com.aiappbuilder.joe123abc', versionCode: 1, versionName: '1.0', html: '<h1>hi</h1>' };

test('generates a complete Android project with no placeholders left', () => {
  const files = generateAndroidFiles(spec);
  const names = files.map((f) => f.name);
  for (const need of [
    'settings.gradle', 'build.gradle', 'gradle.properties', 'app/build.gradle', 'app/src/main/AndroidManifest.xml',
    'app/src/main/res/values/strings.xml', 'app/src/main/assets/index.html', 'app/src/main/java/com/aiappbuilder/joe123abc/MainActivity.java',
  ]) assert.ok(names.includes(need), 'missing ' + need);
  for (const f of files) assert.ok(!/__[A-Z_]+__/.test(f.data.toString()), `placeholder left in ${f.name}`);
  const java = files.find((f) => f.name.endsWith('MainActivity.java')).data.toString();
  assert.match(java, /^package com\.aiappbuilder\.joe123abc;/);
  const strings = files.find((f) => f.name.endsWith('strings.xml')).data.toString();
  assert.match(strings, /Joe\\'s &lt;App&gt; &amp; Co/);
});

test('rejects invalid build descriptions', () => {
  assert.ok(validateSpec({ ...spec, packageName: 'bad name' }).length);
  assert.ok(validateSpec({ ...spec, packageName: 'com.class.x' }).length, 'reserved word');
  assert.ok(validateSpec({ ...spec, appName: '' }).length);
  assert.deepEqual(validateSpec(spec), []);
  assert.throws(() => generateAndroidFiles({ ...spec, packageName: 'x' }));
});

test('package names are always valid', () => {
  for (const n of ['My App', '123', '', '!!!', 'new', 'ÄÖÜ']) {
    const pkg = makePackageName(n, 'abcdef123456');
    assert.deepEqual(validateSpec({ ...spec, packageName: pkg }), [], `${n} -> ${pkg}`);
  }
});

test('the cloud-build preparation script writes the project to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-prep-'));
  const specFile = path.join(dir, 'build.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const out = path.join(dir, 'out');
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'prepare-android.js'), specFile, out]);
  assert.ok(fs.existsSync(path.join(out, 'app/src/main/java/com/aiappbuilder/joe123abc/MainActivity.java')));
  assert.equal(fs.readFileSync(path.join(out, 'app/src/main/assets/index.html'), 'utf8'), '<h1>hi</h1>');

  // invalid input fails loudly with a clear message
  fs.writeFileSync(specFile, JSON.stringify({ ...spec, packageName: 'nope' }));
  const bad = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'prepare-android.js'), specFile, out], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /not valid/);
});

test('zip writer and reader round-trip (and the system unzip agrees)', () => {
  const files = [
    { name: 'a.txt', data: 'hello hello hello hello hello hello' },
    { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 3, 250]) },
    { name: 'ünï.txt', data: 'x' },
  ];
  const zip = createZip(files);
  const back = readZip(zip);
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  assert.equal(back[0].data.toString(), files[0].data);
  assert.deepEqual(back[1].data, files[1].data);

  const tmp = path.join(os.tmpdir(), 'aab-zip-' + process.pid + '.zip');
  fs.writeFileSync(tmp, zip);
  const t = spawnSync('unzip', ['-tq', tmp], { encoding: 'utf8' });
  if (!t.error) assert.equal(t.status, 0, t.stdout + t.stderr);
});

test('error explanations are cautious and never claim a fix', () => {
  const log = ['x', '* What went wrong:', "Execution failed for task ':app:compileDebugJavaWithJavac'.", '> Compilation failed'].join('\n');
  assert.match(extractErrorLines(log), /What went wrong/);

  const cases = [
    ['> Could not resolve com.android.tools.build:gradle:8.5.2', 'A download needed for the build failed'],
    ['SDK location not found. Define a valid SDK location', 'The Android SDK was not found on the build machine'],
    ['No space left on device', 'The build machine ran out of disk space'],
  ];
  for (const [text, title] of cases) {
    const e = explainFailure({ stepName: 'Build APK', logText: `* What went wrong:\n${text}`, conclusion: 'failure' });
    assert.equal(e.title, title);
    assert.match(e.note, /not been fixed automatically/);
  }
  const unknown = explainFailure({ stepName: 'Something odd', logText: 'weird', conclusion: 'failure' });
  assert.equal(unknown.title, 'The build failed');
  assert.equal(explainFailure({ stepName: '', logText: '', conclusion: 'cancelled' }).title, 'The build was cancelled');
});
