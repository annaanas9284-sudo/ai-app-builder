'use strict';
// Starts cloud builds on GitHub Actions and reports their REAL status.
// Nothing here pretends a build succeeded: "success" is only set after the APK file
// has actually been downloaded and verified on this computer.
const crypto = require('crypto');
const fs = require('fs');
const { ApiError } = require('./errors');
const { buildSpec, validateSpec } = require('./android');
const { readZip } = require('./zip');
const { explainFailure, explainGitHubError } = require('./explain');

const ACTIVE = new Set(['preparing', 'queued', 'building', 'finishing']);
const RUN_START_TIMEOUT_MS = 3 * 60 * 1000; // GitHub should show a run within a few minutes
const OVERALL_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_POLL_ERRORS = 6;

function isActive(build) {
  return Boolean(build) && ACTIVE.has(build.status);
}

function isTransient(err) {
  if (!err) return false;
  if (err.kind === 'network') return true;
  if (err.status >= 500) return true;
  if (err.status === 403 && /rate limit/i.test(err.message || '')) return true;
  return false;
}

class BuildManager {
  constructor({ store, github, now = () => Date.now() }) {
    this.store = store;
    this.github = github; // null when cloud build is not configured
    this.now = now;
    this.refreshing = new Set();
  }

  get configured() {
    return Boolean(this.github);
  }

  _iso() {
    return new Date(this.now()).toISOString();
  }

  _fail(build, info, stage = 'Build failed') {
    build.status = 'failed';
    build.stage = stage;
    build.error = info;
    build.finishedAt = this._iso();
    this.store.saveBuild(build);
    return build;
  }

  async start(project) {
    if (!this.github) {
      throw new ApiError(400, 'CLOUD_NOT_CONFIGURED', 'Cloud build is not set up yet. Follow the setup instructions (step 2 and 3 in the README), then restart the app.');
    }
    const previous = project.latestBuildId ? this.store.getBuild(project.latestBuildId) : null;
    if (isActive(previous)) {
      throw new ApiError(409, 'BUILD_IN_PROGRESS', 'A build is already running for this project. Please wait for it to finish.');
    }

    const spec = buildSpec(project);
    const problems = validateSpec(spec);
    if (problems.length) throw new ApiError(400, 'INVALID_PROJECT', 'This project cannot be built yet: ' + problems.join(' '));

    const id = crypto.randomUUID();
    const build = {
      id,
      projectId: project.id,
      status: 'preparing',
      stage: 'Preparing your app',
      progress: 5,
      createdAt: this._iso(),
      updatedAt: this._iso(),
      runId: null,
      runUrl: null,
      apkReady: false,
      apkSize: null,
      error: null,
      pollErrors: 0,
      warning: null,
      app: { name: spec.appName, packageName: spec.packageName },
    };
    this.store.saveBuild(build);
    project.latestBuildId = id;
    this.store.saveProject(project);

    try {
      await this.github.putFile(`builds/${id}.json`, JSON.stringify(spec), `Add build ${id}`);
      await this.github.dispatch(id);
      build.status = 'queued';
      build.stage = 'Sent to the cloud. Waiting for a build machine…';
      build.progress = 10;
      build.dispatchedAt = this._iso();
      this.store.saveBuild(build);
    } catch (err) {
      this._fail(build, explainGitHubError(err), 'Could not start the build');
    }
    return build;
  }

  /** Looks at GitHub and updates the stored build. Safe to call repeatedly. */
  async refresh(build) {
    if (!isActive(build) || !this.github) return build;
    if (this.refreshing.has(build.id)) return this.store.getBuild(build.id) || build;
    this.refreshing.add(build.id);
    try {
      await this._refresh(build);
    } catch (err) {
      if (isTransient(err) && build.pollErrors + 1 < MAX_POLL_ERRORS) {
        build.pollErrors += 1;
        build.warning = 'Having trouble reaching GitHub. Still trying…';
        this.store.saveBuild(build);
      } else {
        this._fail(build, explainGitHubError(err), 'Could not check the build');
      }
    } finally {
      this.refreshing.delete(build.id);
    }
    return build;
  }

  async _refresh(build) {
    const elapsed = this.now() - Date.parse(build.createdAt);
    if (elapsed > OVERALL_TIMEOUT_MS) {
      this._fail(build, {
        title: 'The build is taking too long',
        explanation: 'The build has been running for over an hour, so the app builder stopped waiting for it.',
        suggestions: build.runUrl ? [`Check the run on GitHub: ${build.runUrl}`] : ['Check the Actions tab of your GitHub repository.'],
        details: '',
        note: 'Nothing was fixed automatically.',
      });
      return;
    }

    if (!build.runId) {
      const run = await this.github.findRun(build.id);
      if (!run) {
        if (this.now() - Date.parse(build.dispatchedAt || build.createdAt) > RUN_START_TIMEOUT_MS) {
          this._fail(build, {
            title: 'GitHub did not start the build',
            explanation: 'The build request was sent, but no build appeared on GitHub after a few minutes.',
            suggestions: [
              'Open the Actions tab of your repository and check that the “Build APK” workflow exists and is enabled.',
              'Check GITHUB_BRANCH in .env matches the branch that contains .github/workflows/build-apk.yml.',
            ],
            details: '',
            note: 'Nothing was fixed automatically.',
          }, 'The build never started');
        } else {
          build.stage = 'Waiting for GitHub to start the build…';
          build.warning = null;
          this.store.saveBuild(build);
        }
        return;
      }
      build.runId = run.id;
      build.runUrl = run.html_url || null;
    }

    const run = await this.github.getRun(build.runId);
    build.pollErrors = 0;
    build.warning = null;

    if (run.status !== 'completed') {
      const jobs = await this.github.getJobs(build.runId);
      const steps = (jobs[0] && jobs[0].steps) || [];
      if (run.status === 'in_progress' && steps.length) {
        const done = steps.filter((s) => s.status === 'completed').length;
        const current = steps.find((s) => s.status === 'in_progress');
        build.status = 'building';
        build.progress = Math.min(90, 15 + Math.round((75 * done) / steps.length));
        build.stage = current ? `Building: ${current.name}` : 'Building…';
      } else if (run.status === 'in_progress') {
        build.status = 'building';
        build.progress = 15;
        build.stage = 'Building…';
      } else {
        build.status = 'queued';
        build.progress = 10;
        build.stage = 'Waiting for a build machine…';
      }
      this.store.saveBuild(build);
      return;
    }

    if (run.conclusion === 'success') {
      await this._finishSuccess(build);
    } else {
      await this._finishFailure(build, run.conclusion);
    }
  }

  async _finishSuccess(build) {
    build.status = 'finishing';
    build.stage = 'Downloading your APK…';
    build.progress = 95;
    this.store.saveBuild(build);
    try {
      const artifacts = await this.github.listArtifacts(build.runId);
      const art = artifacts.find((a) => a.name === `apk-${build.id}` && !a.expired);
      if (!art) throw new Error('The build finished but no APK file was attached to it.');
      const zip = await this.github.downloadArtifact(art.id);
      const apkEntry = readZip(zip).find((e) => e.name.toLowerCase().endsWith('.apk'));
      if (!apkEntry || apkEntry.data.length < 4) throw new Error('The downloaded package did not contain an APK file.');
      // An APK is itself a ZIP file, so it must start with "PK".
      if (apkEntry.data[0] !== 0x50 || apkEntry.data[1] !== 0x4b) throw new Error('The downloaded APK file is not valid.');
      fs.writeFileSync(this.store.apkPath(build.id), apkEntry.data);
      build.status = 'success';
      build.stage = 'Your APK is ready';
      build.progress = 100;
      build.apkReady = true;
      build.apkSize = apkEntry.data.length;
      build.finishedAt = this._iso();
      this.store.saveBuild(build);
    } catch (err) {
      if (isTransient(err)) throw err; // try again on the next check
      this._fail(build, {
        title: 'The build finished, but the APK could not be downloaded',
        explanation: 'GitHub reports the build as successful, but this app could not get the APK file from it.',
        suggestions: [build.runUrl ? `You can try downloading it from GitHub yourself: ${build.runUrl}` : 'Check the run on GitHub.', 'Or press “Build again”.'],
        details: err.message,
        note: 'Nothing was fixed automatically.',
      }, 'APK download failed');
    }
  }

  async _finishFailure(build, conclusion) {
    let stepName = '';
    let logText = '';
    try {
      const jobs = await this.github.getJobs(build.runId);
      const job = jobs.find((j) => j.conclusion === 'failure') || jobs[0];
      if (job) {
        const step = (job.steps || []).find((s) => s.conclusion === 'failure');
        stepName = step ? step.name : '';
        try { logText = await this.github.getJobLogs(job.id); } catch (_) { /* logs may be unavailable */ }
      }
    } catch (err) {
      if (isTransient(err)) throw err;
    }
    const info = explainFailure({ stepName, logText, conclusion });
    if (!info.details && !logText) {
      info.details = 'The build log could not be downloaded.' + (build.runUrl ? ` You can read it on GitHub: ${build.runUrl}` : '');
    }
    this._fail(build, info);
  }
}

module.exports = { BuildManager, isActive };
