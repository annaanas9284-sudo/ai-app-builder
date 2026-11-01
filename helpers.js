'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');
const { Store } = require('../lib/store');
const { GitHubClient } = require('../lib/github');
const { BuildManager } = require('../lib/builds');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aab-test-'));
}

/** Starts the real app server on a random port. Pass `fake` (from startFakeGitHub) to enable cloud build. */
async function startApp({ dataDir = tempDir(), fake = null, now } = {}) {
  const store = new Store(dataDir);
  const github = fake
    ? new GitHubClient({ apiUrl: fake.url, token: 'test-token', repo: 'owner/repo', branch: 'main', workflow: 'build-apk.yml' })
    : null;
  const builds = new BuildManager({ store, github, now });
  const settings = { host: '127.0.0.1', port: 0, dataDir, github: { repo: 'owner/repo' }, cloudBuildConfigured: Boolean(github) };
  const server = createServer({ settings, store, github, builds });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  return { base, call, dataDir, store, builds, close: () => new Promise((r) => server.close(r)) };
}

async function waitFor(fn, { timeout = 8000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
}

module.exports = { startApp, tempDir, waitFor };
