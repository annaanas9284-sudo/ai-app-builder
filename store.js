'use strict';
// Simple file-based storage. One JSON file per project and per build.
// Writes are atomic (write to a temp file, then rename) so a crash cannot corrupt a project.
const fs = require('fs');
const path = require('path');
const { isValidId } = require('./validate');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.projectsDir = path.join(dir, 'projects');
    this.buildsDir = path.join(dir, 'builds');
    fs.mkdirSync(this.projectsDir, { recursive: true });
    fs.mkdirSync(this.buildsDir, { recursive: true });
  }

  _write(file, obj) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  }

  _read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not read ${file}: ${err.message}`);
      return null;
    }
  }

  // ---- projects ----
  listProjects() {
    const out = [];
    for (const f of fs.readdirSync(this.projectsDir)) {
      if (!f.endsWith('.json')) continue;
      const p = this._read(path.join(this.projectsDir, f));
      if (p && p.id) out.push(p);
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  getProject(id) {
    if (!isValidId(id)) return null;
    return this._read(path.join(this.projectsDir, `${id}.json`));
  }

  saveProject(project) {
    if (!isValidId(project.id)) throw new Error('Invalid project id');
    this._write(path.join(this.projectsDir, `${project.id}.json`), project);
    return project;
  }

  deleteProject(id) {
    if (!isValidId(id)) return false;
    const file = path.join(this.projectsDir, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    for (const b of this.listBuilds()) {
      if (b.projectId === id) this.deleteBuild(b.id);
    }
    return true;
  }

  // ---- builds ----
  listBuilds() {
    const out = [];
    for (const f of fs.readdirSync(this.buildsDir)) {
      if (!f.endsWith('.json')) continue;
      const b = this._read(path.join(this.buildsDir, f));
      if (b && b.id) out.push(b);
    }
    return out;
  }

  getBuild(id) {
    if (!isValidId(id)) return null;
    return this._read(path.join(this.buildsDir, `${id}.json`));
  }

  saveBuild(build) {
    if (!isValidId(build.id)) throw new Error('Invalid build id');
    build.updatedAt = new Date().toISOString();
    this._write(path.join(this.buildsDir, `${build.id}.json`), build);
    return build;
  }

  deleteBuild(id) {
    if (!isValidId(id)) return;
    for (const f of [`${id}.json`, `${id}.apk`]) {
      try { fs.unlinkSync(path.join(this.buildsDir, f)); } catch (_) { /* already gone */ }
    }
  }

  apkPath(buildId) {
    if (!isValidId(buildId)) return null;
    return path.join(this.buildsDir, `${buildId}.apk`);
  }
}

module.exports = { Store };
