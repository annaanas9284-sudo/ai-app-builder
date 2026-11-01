'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, tempDir } = require('./helpers');
const { readZip } = require('../lib/zip');

test('create, list, open, rename, edit and delete a project', async () => {
  const app = await startApp();
  try {
    // create
    const created = await app.call('POST', '/api/projects', { name: '  My   First App  ' });
    assert.equal(created.status, 201);
    const p = created.data.project;
    assert.equal(p.name, 'My First App'); // whitespace cleaned
    assert.match(p.packageName, /^com\.aiappbuilder\.[a-z][a-z0-9]*$/);

    // list
    const list = await app.call('GET', '/api/projects');
    assert.equal(list.data.projects.length, 1);
    assert.equal(list.data.projects[0].id, p.id);

    // open
    const opened = await app.call('GET', `/api/projects/${p.id}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.data.project.config.appName, 'My First App');

    // rename
    const renamed = await app.call('PATCH', `/api/projects/${p.id}`, { name: 'Renamed' });
    assert.equal(renamed.data.project.name, 'Renamed');

    // edit settings
    const edited = await app.call('PATCH', `/api/projects/${p.id}`, {
      config: { appName: "Joe's App", heading: 'Hi there', message: 'Line 1\nLine 2', color: '#AA33CC' },
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.project.config, { appName: "Joe's App", heading: 'Hi there', message: 'Line 1\nLine 2', color: '#aa33cc' });

    // delete
    const del = await app.call('DELETE', `/api/projects/${p.id}`);
    assert.equal(del.status, 200);
    assert.equal((await app.call('GET', `/api/projects/${p.id}`)).status, 404);
    assert.equal((await app.call('GET', '/api/projects')).data.projects.length, 0);
    assert.equal((await app.call('DELETE', `/api/projects/${p.id}`)).status, 404);
  } finally { await app.close(); }
});

test('projects are really saved: they survive a server restart', async () => {
  const dataDir = tempDir();
  let app = await startApp({ dataDir });
  const { data } = await app.call('POST', '/api/projects', { name: 'Persistent' });
  const id = data.project.id;
  await app.call('PATCH', `/api/projects/${id}`, { config: { heading: 'Saved heading' } });
  await app.close();

  app = await startApp({ dataDir }); // brand-new server, same folder
  try {
    const list = await app.call('GET', '/api/projects');
    assert.equal(list.data.projects.length, 1);
    assert.equal(list.data.projects[0].name, 'Persistent');
    const again = await app.call('GET', `/api/projects/${id}`);
    assert.equal(again.data.project.config.heading, 'Saved heading');
  } finally { await app.close(); }
});

test('input is validated with clear messages', async () => {
  const app = await startApp();
  try {
    let r = await app.call('POST', '/api/projects', { name: '   ' });
    assert.equal(r.status, 400);
    assert.match(r.data.error.message, /enter a name/i);

    r = await app.call('POST', '/api/projects', {});
    assert.equal(r.status, 400);

    r = await app.call('POST', '/api/projects', { name: 'x'.repeat(61) });
    assert.equal(r.status, 400);
    assert.match(r.data.error.message, /too long/i);

    const ok = await app.call('POST', '/api/projects', { name: 'Valid' });
    const id = ok.data.project.id;
    r = await app.call('PATCH', `/api/projects/${id}`, { config: { color: 'red' } });
    assert.equal(r.status, 400);
    r = await app.call('PATCH', `/api/projects/${id}`, { config: { appName: '' } });
    assert.equal(r.status, 400);
    r = await app.call('PATCH', `/api/projects/${id}`, { name: '' });
    assert.equal(r.status, 400);
    // a failed edit does not change anything
    assert.equal((await app.call('GET', `/api/projects/${id}`)).data.project.name, 'Valid');

    assert.equal((await app.call('GET', '/api/projects/not-a-real-id')).status, 404);
    assert.equal((await app.call('GET', '/api/projects/../../etc/passwd')).status, 404);
  } finally { await app.close(); }
});

test('project names that are numbers or symbols still get a valid Android package name', async () => {
  const app = await startApp();
  try {
    for (const name of ['123', '!!!', 'class', 'Über App']) {
      const { data } = await app.call('POST', '/api/projects', { name });
      assert.match(data.project.packageName, /^com\.aiappbuilder\.[a-z][a-z0-9]*$/, name);
    }
  } finally { await app.close(); }
});

test('preview and Android project export work', async () => {
  const app = await startApp();
  try {
    const { data } = await app.call('POST', '/api/projects', { name: 'Exporty' });
    const id = data.project.id;
    await app.call('PATCH', `/api/projects/${id}`, { config: { appName: "Tom & Jerry's", heading: '<b>x</b>' } });

    const prev = await app.call('POST', '/api/preview', { config: { heading: '<script>alert(1)</script>' } });
    assert.equal(prev.status, 200);
    assert.ok(!prev.data.html.includes('<script>alert'), 'user text is escaped');

    const zipRes = await app.call('GET', `/api/projects/${id}/export`);
    assert.equal(zipRes.status, 200);
    const files = readZip(zipRes.data);
    const names = files.map((f) => f.name);
    const pkgPath = data.project.packageName.replace(/\./g, '/');
    assert.ok(names.includes(`app/src/main/java/${pkgPath}/MainActivity.java`), 'MainActivity in the right package folder');
    assert.ok(names.includes('app/src/main/assets/index.html'));
    assert.ok(names.includes('app/build.gradle') && names.includes('settings.gradle'));
    const strings = files.find((f) => f.name.endsWith('strings.xml')).data.toString();
    assert.match(strings, /Tom &amp; Jerry\\'s/);
    const gradle = files.find((f) => f.name === 'app/build.gradle').data.toString();
    assert.ok(gradle.includes(`namespace '${data.project.packageName}'`));
    assert.ok(!/__[A-Z_]+__/.test(gradle), 'no placeholders left');
  } finally { await app.close(); }
});

test('without cloud setup, Build is refused honestly and no APK is offered', async () => {
  const app = await startApp();
  try {
    const cfg = await app.call('GET', '/api/config');
    assert.equal(cfg.data.cloudBuild.configured, false);
    const { data } = await app.call('POST', '/api/projects', { name: 'NoCloud' });
    const id = data.project.id;
    const r = await app.call('POST', `/api/projects/${id}/build`);
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'CLOUD_NOT_CONFIGURED');
    assert.equal((await app.call('GET', `/api/projects/${id}/build`)).data.build, null);
    assert.equal((await app.call('GET', '/api/builds/00000000-0000-0000-0000-000000000000/apk')).status, 404);
  } finally { await app.close(); }
});

test('the web page is served, other websites cannot post, and files outside public/ are not reachable', async () => {
  const app = await startApp();
  try {
    const page = await fetch(app.base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AI App Builder/);
    assert.equal((await fetch(app.base + '/app.js')).status, 200);
    assert.equal((await fetch(app.base + '/style.css')).status, 200);
    assert.equal((await fetch(app.base + '/%2e%2e/package.json')).status, 404);

    const evil = await app.call('POST', '/api/projects', { name: 'Evil' }, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const same = await app.call('POST', '/api/projects', { name: 'Fine' }, { Origin: app.base });
    assert.equal(same.status, 201);
  } finally { await app.close(); }
});
