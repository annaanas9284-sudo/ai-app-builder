'use strict';
// Turns a project into a complete Android (Gradle) project.
// Shared by the server (export + build preparation) and scripts/prepare-android.js (runs in the cloud build).
const fs = require('fs');
const path = require('path');
const { renderHomePage } = require('./template');

const TEMPLATE_DIR = path.join(__dirname, '..', 'android-template');
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum ' +
  'extends final finally float for goto if implements import instanceof int interface long native new package private protected ' +
  'public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null').split(' '));

/** e.g. "My Cool App" + id -> com.aiappbuilder.mycoolapp3f9a1c */
function makePackageName(name, id) {
  let slug = String(name).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  if (!slug || /^[0-9]/.test(slug)) slug = 'app' + slug;
  const suffix = String(id).replace(/[^a-f0-9]/gi, '').toLowerCase().slice(0, 6) || '000000';
  return `com.aiappbuilder.${slug}${suffix}`;
}

/** Everything the cloud build needs to know, as plain data. */
function buildSpec(project) {
  return {
    appName: project.config.appName,
    packageName: project.packageName,
    versionCode: 1,
    versionName: '1.0',
    html: renderHomePage(project.config),
  };
}

/** Returns a list of problems (empty list = OK). */
function validateSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['The build description is missing.'];
  if (typeof spec.appName !== 'string' || !spec.appName.trim()) problems.push('The app name is empty.');
  else if (spec.appName.length > 30) problems.push('The app name is longer than 30 characters.');
  if (typeof spec.packageName !== 'string' || !PACKAGE_RE.test(spec.packageName)) {
    problems.push('The Android package name is not valid.');
  } else if (spec.packageName.split('.').some((seg) => JAVA_KEYWORDS.has(seg))) {
    problems.push('The Android package name contains a reserved word.');
  }
  if (!Number.isInteger(spec.versionCode) || spec.versionCode < 1) problems.push('The version code is invalid.');
  if (typeof spec.versionName !== 'string' || !/^[0-9A-Za-z._-]{1,20}$/.test(spec.versionName)) problems.push('The version name is invalid.');
  if (typeof spec.html !== 'string' || !spec.html.trim()) problems.push('The app screen is empty.');
  return problems;
}

/** Escapes text for an Android strings.xml value. */
function androidString(s) {
  let out = String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'");
  if (/^[@?]/.test(out)) out = '\\' + out;
  return out;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Returns [{ name, data }] for every file of the Android project. */
function generateAndroidFiles(spec) {
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(problems.join(' '));

  const subs = {
    __PACKAGE__: spec.packageName,
    __PACKAGE_PATH__: spec.packageName.replace(/\./g, '/'),
    __APP_NAME__: androidString(spec.appName),
    __VERSION_CODE__: String(spec.versionCode),
    __VERSION_NAME__: spec.versionName,
  };
  const apply = (text) => text.replace(/__[A-Z_]+__/g, (m) => (m in subs ? subs[m] : m));

  const files = [];
  for (const rel of walk(TEMPLATE_DIR)) {
    const text = fs.readFileSync(path.join(TEMPLATE_DIR, rel), 'utf8');
    let outName = rel;
    if (rel.endsWith('.tpl')) outName = apply(rel.slice(0, -4));
    files.push({ name: outName, data: apply(text) });
  }
  files.push({ name: 'app/src/main/assets/index.html', data: spec.html });
  return files;
}

module.exports = { makePackageName, buildSpec, validateSpec, generateAndroidFiles, androidString, TEMPLATE_DIR };
