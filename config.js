'use strict';
const fs = require('fs');
const path = require('path');

/** Reads KEY=value lines from a .env file into process.env (existing variables win). */
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function getSettings(env = process.env) {
  const repo = (env.GITHUB_REPO || '').trim();
  const token = (env.GITHUB_TOKEN || '').trim();
  const repoOk = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT) || 3000,
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    github: {
      token,
      repo,
      branch: (env.GITHUB_BRANCH || 'main').trim(),
      workflow: (env.GITHUB_WORKFLOW || 'build-apk.yml').trim(),
      apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    },
    cloudBuildConfigured: Boolean(token && repoOk),
  };
}

module.exports = { loadDotEnv, getSettings };
