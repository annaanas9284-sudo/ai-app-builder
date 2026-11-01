'use strict';
// A pretend GitHub API used ONLY by the tests. It lets us test the real build code
// (start, progress, success, failure, download) without needing a GitHub account.
// It does NOT prove that the real GitHub workflow or Gradle build works.
const http = require('http');
const { createZip } = require('../lib/zip');

const FAKE_APK = createZip([{ name: 'AndroidManifest.xml', data: 'fake apk content for tests' }]);

/**
 * scenario: 'success' | 'failure-compile' | 'failure-network' | 'bad-token' | 'no-run'
 */
function startFakeGitHub({ scenario = 'success', token = 'test-token', repo = 'owner/repo', port = 0 } = {}) {
  const state = { files: {}, dispatched: [], runCalls: 0, buildId: null, scenario };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (req.headers.authorization !== `Bearer ${token}` || state.scenario === 'bad-token') return json(401, { message: 'Bad credentials' });

      const base = `/repos/${repo}`;
      let m;
      if (req.method === 'PUT' && (m = p.match(new RegExp(`^${base}/contents/(.+)$`)))) {
        state.files[m[1]] = Buffer.from(body.content, 'base64').toString('utf8');
        return json(201, { content: { path: m[1] } });
      }
      if (req.method === 'POST' && p === `${base}/actions/workflows/build-apk.yml/dispatches`) {
        state.buildId = body.inputs.build_id;
        state.dispatched.push(body);
        res.writeHead(204); // real GitHub answers "204 No Content"
        return res.end();
      }
      if (req.method === 'GET' && p === `${base}/actions/workflows/build-apk.yml/runs`) {
        if (state.scenario === 'no-run' || !state.buildId) return json(200, { workflow_runs: [] });
        return json(200, { workflow_runs: [{ id: 1001, display_title: `Build ${state.buildId}`, name: `Build ${state.buildId}`, html_url: `https://github.com/${repo}/actions/runs/1001` }] });
      }
      if (req.method === 'GET' && p === `${base}/actions/runs/1001`) {
        state.runCalls += 1;
        if (state.scenario === 'failure-network' && state.runCalls === 2) {
          // simulate a temporary GitHub outage
          return json(503, { message: 'Service unavailable' });
        }
        const done = state.runCalls >= 3;
        const conclusion = state.scenario.startsWith('failure') ? 'failure' : 'success';
        return json(200, { id: 1001, status: state.runCalls === 1 ? 'queued' : done ? 'completed' : 'in_progress', conclusion: done ? conclusion : null, html_url: `https://github.com/${repo}/actions/runs/1001` });
      }
      if (req.method === 'GET' && p === `${base}/actions/runs/1001/jobs`) {
        const failing = state.scenario === 'failure-compile';
        const finished = state.runCalls >= 3;
        const steps = [
          { name: 'Check out the project', status: 'completed', conclusion: 'success' },
          { name: 'Prepare Android project', status: 'completed', conclusion: 'success' },
          { name: 'Set up Java', status: finished ? 'completed' : 'in_progress', conclusion: finished ? 'success' : null },
          { name: 'Build APK', status: finished ? 'completed' : 'pending', conclusion: finished ? (failing ? 'failure' : 'success') : null },
          { name: 'Save APK', status: finished && !failing ? 'completed' : 'pending', conclusion: finished && !failing ? 'success' : null },
        ];
        return json(200, { jobs: [{ id: 2001, conclusion: finished ? (failing ? 'failure' : 'success') : null, steps }] });
      }
      if (req.method === 'GET' && p === `${base}/actions/jobs/2001/logs`) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end([
          '2026-10-31T10:00:00.0000000Z ##[group]Run gradle assembleDebug',
          '2026-10-31T10:00:05.0000000Z warning: unrelated namespace warning that should not matter',
          "2026-10-31T10:00:09.0000000Z /work/app/src/main/java/com/x/MainActivity.java:12: error: cannot find symbol",
          '2026-10-31T10:00:10.0000000Z * What went wrong:',
          "2026-10-31T10:00:10.0000000Z Execution failed for task ':app:compileDebugJavaWithJavac'.",
          '2026-10-31T10:00:10.0000000Z > Compilation failed; see the compiler error output for details.',
          '2026-10-31T10:00:11.0000000Z BUILD FAILED in 14s',
        ].join('\n'));
      }
      if (req.method === 'GET' && p === `${base}/actions/runs/1001/artifacts`) {
        return json(200, { artifacts: [{ id: 7, name: `apk-${state.buildId}`, expired: false }] });
      }
      if (req.method === 'GET' && p === `${base}/actions/artifacts/7/zip`) {
        const zip = createZip([{ name: 'app-debug.apk', data: FAKE_APK }]);
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        return res.end(zip);
      }
      json(404, { message: 'Not Found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, url, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startFakeGitHub, FAKE_APK };

// Run by hand:  SCENARIO=success PORT=4010 node test/fake-github.js
if (require.main === module) {
  startFakeGitHub({ scenario: process.env.SCENARIO || 'success', port: Number(process.env.PORT) || 4010 })
    .then((f) => console.log('Fake GitHub listening at ' + f.url));
}
