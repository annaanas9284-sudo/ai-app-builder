'use strict';
// Tests the real build code against a PRETEND GitHub (test/fake-github.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startApp, waitFor } = require('./helpers');
const { startFakeGitHub, FAKE_APK } = require('./fake-github');

async function makeProject(app, name = 'Builder') {
  const { data } = await app.call('POST', '/api/projects', { name });
  return data.project.id;
}

async function pollUntilDone(app, id) {
  let last;
  await waitFor(async () => {
    last = (await app.call('GET', `/api/projects/${id}/build`)).data.build;
    return last && !['preparing', 'queued', 'building', 'finishing'].includes(last.status);
  });
  return last;
}

test('successful build: real progress, then a downloadable APK (and only then)', async () => {
  const fake = await startFakeGitHub({ scenario: 'success' });
  const app = await startApp({ fake });
  try {
    const id = await makeProject(app);
    const started = await app.call('POST', `/api/projects/${id}/build`);
    assert.equal(started.status, 202);
    const buildId = started.data.build.id;
    assert.equal(started.data.build.status, 'queued');
    assert.equal(started.data.build.apkReady, false);

    // the build description really was sent to the (fake) repository and the workflow was started
    assert.ok(fake.state.files[`builds/${buildId}.json`], 'build file uploaded');
    const spec = JSON.parse(fake.state.files[`builds/${buildId}.json`]);
    assert.match(spec.packageName, /^com\.aiappbuilder\./);
    assert.deepEqual(fake.state.dispatched[0].inputs, { build_id: buildId });

    // no APK before success
    assert.equal((await app.call('GET', `/api/builds/${buildId}/apk`)).status, 404);

    // a second build while one runs is refused
    assert.equal((await app.call('POST', `/api/projects/${id}/build`)).status, 409);

    // watch progress move forward and never decrease while active
    const seen = [];
    let build;
    await waitFor(async () => {
      build = (await app.call('GET', `/api/projects/${id}/build`)).data.build;
      seen.push(build.progress);
      if (build.status !== 'success') assert.equal(build.apkReady, false, 'no download offered before success');
      return build.status === 'success';
    });
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'progress never goes backwards: ' + seen.join(','));
    assert.equal(build.progress, 100);
    assert.equal(build.apkReady, true);
    assert.equal(build.runUrl, 'https://github.com/owner/repo/actions/runs/1001');

    // download works and is the actual file that came from the build
    const apk = await app.call('GET', `/api/builds/${buildId}/apk`);
    assert.equal(apk.status, 200);
    assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(apk.headers.get('content-disposition'), /builder\.apk/);
    assert.deepEqual(Buffer.from(apk.data), FAKE_APK);

    // project list shows the build state
    const list = await app.call('GET', '/api/projects');
    assert.equal(list.data.projects[0].latestBuild.apkReady, true);

    // building again is allowed after finishing
    assert.equal((await app.call('POST', `/api/projects/${id}/build`)).status, 202);

    // deleting the project removes its builds and APKs
    await app.call('DELETE', `/api/projects/${id}`);
    assert.equal((await app.call('GET', `/api/builds/${buildId}/apk`)).status, 404);
    assert.ok(!fs.existsSync(app.store.apkPath(buildId)));
  } finally { await app.close(); await fake.close(); }
});

test('failed build: real error is captured and explained, nothing is claimed fixed, no download', async () => {
  const fake = await startFakeGitHub({ scenario: 'failure-compile' });
  const app = await startApp({ fake });
  try {
    const id = await makeProject(app);
    const started = await app.call('POST', `/api/projects/${id}/build`);
    const buildId = started.data.build.id;
    const build = await pollUntilDone(app, id);

    assert.equal(build.status, 'failed');
    assert.equal(build.apkReady, false);
    assert.equal(build.error.title, 'The app code did not compile');
    assert.match(build.error.explanation, /Build APK/); // names the failing step
    assert.match(build.error.details, /cannot find symbol/); // real log lines are shown
    assert.match(build.error.details, /What went wrong/);
    assert.doesNotMatch(build.error.details, /unrelated namespace warning/);
    assert.match(build.error.note, /not been fixed automatically/i);
    assert.doesNotMatch(JSON.stringify(build), /(was|been) (automatically )?fixed(?! automatically)/i);
    assert.equal((await app.call('GET', `/api/builds/${buildId}/apk`)).status, 404);
    assert.equal((await app.call('GET', '/api/projects')).data.projects[0].latestBuild.status, 'failed');

    // the user can try again
    assert.equal((await app.call('POST', `/api/projects/${id}/build`)).status, 202);
  } finally { await app.close(); await fake.close(); }
});

test('a temporary GitHub outage while checking does not fail the build', async () => {
  const fake = await startFakeGitHub({ scenario: 'failure-network' });
  const app = await startApp({ fake });
  try {
    const id = await makeProject(app);
    await app.call('POST', `/api/projects/${id}/build`);
    const warnings = [];
    const build = await waitFor(async () => {
      const b = (await app.call('GET', `/api/projects/${id}/build`)).data.build;
      if (b.warning) warnings.push(b.warning);
      return b.status === 'failed' ? b : null;
    });
    assert.ok(warnings.length >= 1, 'user was told GitHub could not be reached');
    // it ended with the real build result (the fake build fails at the end), not a made-up network failure
    assert.equal(build.error.title === 'Could not reach GitHub', false);
  } finally { await app.close(); await fake.close(); }
});

test('wrong GitHub token gives a clear explanation', async () => {
  const fake = await startFakeGitHub({ scenario: 'bad-token' });
  const app = await startApp({ fake });
  try {
    const id = await makeProject(app);
    const r = await app.call('POST', `/api/projects/${id}/build`);
    assert.equal(r.status, 202);
    assert.equal(r.data.build.status, 'failed');
    assert.equal(r.data.build.error.title, 'GitHub did not accept your token');
    assert.match(r.data.build.error.suggestions.join(' '), /GITHUB_TOKEN/);
    assert.equal(r.data.build.apkReady, false);
  } finally { await app.close(); await fake.close(); }
});

test('GitHub unreachable gives a clear explanation', async () => {
  const fake = await startFakeGitHub({ scenario: 'success' });
  const app = await startApp({ fake });
  await fake.close(); // nothing is listening any more
  try {
    const id = await makeProject(app);
    const r = await app.call('POST', `/api/projects/${id}/build`);
    assert.equal(r.data.build.status, 'failed');
    assert.equal(r.data.build.error.title, 'Could not reach GitHub');
  } finally { await app.close(); }
});

test('if GitHub never starts the build, it is reported instead of waiting forever', async () => {
  const fake = await startFakeGitHub({ scenario: 'no-run' });
  let clock = Date.now();
  const app = await startApp({ fake, now: () => clock });
  try {
    const id = await makeProject(app);
    await app.call('POST', `/api/projects/${id}/build`);
    let b = (await app.call('GET', `/api/projects/${id}/build`)).data.build;
    assert.equal(b.status, 'queued');
    assert.match(b.stage, /Waiting for GitHub/);
    clock += 4 * 60 * 1000; // four minutes later
    b = (await app.call('GET', `/api/projects/${id}/build`)).data.build;
    assert.equal(b.status, 'failed');
    assert.equal(b.error.title, 'GitHub did not start the build');
  } finally { await app.close(); await fake.close(); }
});
