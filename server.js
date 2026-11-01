'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadDotEnv, getSettings } = require('./lib/config');
const { Store } = require('./lib/store');
const { ApiError } = require('./lib/errors');
const { cleanName, cleanConfig, isValidId } = require('./lib/validate');
const { defaultConfig, renderHomePage } = require('./lib/template');
const { makePackageName, buildSpec, generateAndroidFiles } = require('./lib/android');
const { createZip } = require('./lib/zip');
const { GitHubClient } = require('./lib/github');
const { BuildManager } = require('./lib/builds');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'TOO_LARGE', 'That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new ApiError(400, 'INVALID_JSON', 'The request was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function fileSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

function createServer(options = {}) {
  const settings = options.settings || getSettings();
  const store = options.store || new Store(settings.dataDir);
  const github = options.github !== undefined
    ? options.github
    : settings.cloudBuildConfigured ? new GitHubClient(settings.github) : null;
  const builds = options.builds || new BuildManager({ store, github });

  // ---- helpers ----
  const publicBuild = (b) => (b ? {
    id: b.id, projectId: b.projectId, status: b.status, stage: b.stage, progress: b.progress,
    runUrl: b.runUrl, apkReady: Boolean(b.apkReady && b.status === 'success'), apkSize: b.apkSize,
    error: b.error, warning: b.warning, createdAt: b.createdAt, finishedAt: b.finishedAt || null, app: b.app,
  } : null);

  const publicProject = (p) => ({
    id: p.id, name: p.name, config: p.config, packageName: p.packageName,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  });

  const mustProject = (id) => {
    const p = isValidId(id) ? store.getProject(id) : null;
    if (!p) throw new ApiError(404, 'NOT_FOUND', 'That project could not be found. It may have been deleted.');
    return p;
  };

  // ---- routes ----
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/config', async () => ({
    status: 200,
    body: { cloudBuild: { configured: builds.configured, repo: builds.configured ? settings.github.repo : null } },
  }));

  route('GET', '/api/projects', async () => {
    const list = store.listProjects().map((p) => {
      const b = p.latestBuildId ? store.getBuild(p.latestBuildId) : null;
      return { ...publicProject(p), latestBuild: b ? { status: b.status, apkReady: Boolean(b.apkReady && b.status === 'success') } : null };
    });
    return { status: 200, body: { projects: list } };
  });

  route('POST', '/api/projects', async ({ body }) => {
    const name = cleanName(body.name);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const project = {
      id,
      name,
      source: 'manual', // reserved so that future generated projects can be told apart
      packageName: makePackageName(name, id.replace(/-/g, '')),
      config: defaultConfig(name),
      createdAt: now,
      updatedAt: now,
      latestBuildId: null,
    };
    store.saveProject(project);
    return { status: 201, body: { project: publicProject(project) } };
  });

  route('GET', '/api/projects/:id', async ({ params }) => ({ status: 200, body: { project: publicProject(mustProject(params.id)) } }));

  route('PATCH', '/api/projects/:id', async ({ params, body }) => {
    const project = mustProject(params.id);
    if (body.name !== undefined) project.name = cleanName(body.name);
    if (body.config !== undefined) project.config = cleanConfig(body.config, project.config);
    project.updatedAt = new Date().toISOString();
    store.saveProject(project);
    return { status: 200, body: { project: publicProject(project) } };
  });

  route('DELETE', '/api/projects/:id', async ({ params }) => {
    mustProject(params.id);
    store.deleteProject(params.id);
    return { status: 200, body: { ok: true } };
  });

  route('POST', '/api/preview', async ({ body }) => {
    const config = cleanConfig(body.config, defaultConfig('My App'));
    return { status: 200, body: { html: renderHomePage(config) } };
  });

  route('POST', '/api/projects/:id/build', async ({ params }) => {
    const project = mustProject(params.id);
    const build = await builds.start(project);
    return { status: 202, body: { build: publicBuild(build) } };
  });

  route('GET', '/api/projects/:id/build', async ({ params }) => {
    const project = mustProject(params.id);
    let build = project.latestBuildId ? store.getBuild(project.latestBuildId) : null;
    if (build) build = await builds.refresh(build);
    return { status: 200, body: { build: publicBuild(build) } };
  });

  route('GET', '/api/builds/:id/apk', async ({ params, res }) => {
    const build = store.getBuild(params.id);
    const file = build && store.apkPath(build.id);
    if (!build || build.status !== 'success' || !build.apkReady || !fs.existsSync(file)) {
      throw new ApiError(404, 'NO_APK', 'There is no APK to download. The build has not finished successfully.');
    }
    const project = store.getProject(build.projectId);
    const filename = `${fileSlug(project ? project.name : build.app && build.app.name)}.apk`;
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    res.end(data);
    return null;
  });

  route('GET', '/api/projects/:id/export', async ({ params, res }) => {
    const project = mustProject(params.id);
    const zip = createZip(generateAndroidFiles(buildSpec(project)));
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zip.length,
      'Content-Disposition': `attachment; filename="${fileSlug(project.name)}-android-project.zip"`,
    });
    res.end(zip);
    return null;
  });

  // ---- static files ----
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: { code: 'METHOD', message: 'Method not allowed.' } });
        return serveStatic(req, res, pathname);
      }

      // Block requests coming from other websites (protects the GitHub token on shared networks).
      if (req.method !== 'GET' && req.headers.origin) {
        let originHost = '';
        try { originHost = new URL(req.headers.origin).host; } catch (_) { /* invalid */ }
        if (originHost !== req.headers.host) throw new ApiError(403, 'FORBIDDEN', 'Request blocked.');
      }

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
        const out = await r.handler({ req, res, params, body, url });
        if (out) sendJson(res, out.status, out.body);
        return;
      }
      throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      console.error(err);
      sendJson(res, 500, { error: { code: 'SERVER_ERROR', message: 'Something went wrong on the server. Please try again.' } });
    }
  });

  server.appContext = { store, builds, settings };
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  loadDotEnv(path.join(__dirname, '.env'));
  const settings = getSettings();
  const server = createServer({ settings });
  server.listen(settings.port, settings.host, () => {
    console.log(`AI App Builder is running:  http://${settings.host === '0.0.0.0' ? 'localhost' : settings.host}:${settings.port}`);
    console.log(settings.cloudBuildConfigured
      ? `Cloud build: ON  (repository ${settings.github.repo}, branch ${settings.github.branch})`
      : 'Cloud build: OFF (set GITHUB_TOKEN and GITHUB_REPO in .env to enable it — see README.md)');
  });
}
