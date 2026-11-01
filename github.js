'use strict';
// Minimal GitHub REST client (Node's built-in fetch). The token never leaves the server.

class GitHubError extends Error {
  /** kind: 'network' | 'http' */
  constructor(status, message, kind = 'http') {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

class GitHubClient {
  constructor({ apiUrl = 'https://api.github.com', token, repo, branch = 'main', workflow = 'build-apk.yml' }) {
    this.apiUrl = apiUrl;
    this.token = token;
    this.repo = repo;
    this.branch = branch;
    this.workflow = workflow;
  }

  async _request(method, path, body) {
    let res;
    try {
      res = await fetch(this.apiUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ai-app-builder',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'follow',
      });
    } catch (err) {
      throw new GitHubError(0, `Could not reach GitHub (${err.cause && err.cause.code ? err.cause.code : err.message}).`, 'network');
    }
    if (!res.ok) {
      let message = res.statusText;
      try {
        const data = await res.json();
        if (data && data.message) message = data.message;
      } catch (_) { /* not JSON */ }
      throw new GitHubError(res.status, message);
    }
    return res;
  }

  async _json(method, path, body) {
    const res = await this._request(method, path, body);
    return res.status === 204 ? null : res.json();
  }

  /** Creates builds/<id>.json (or any new file) on the configured branch. */
  async putFile(filePath, content, message) {
    return this._json('PUT', `/repos/${this.repo}/contents/${filePath}`, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: this.branch,
    });
  }

  async dispatch(buildId) {
    return this._json('POST', `/repos/${this.repo}/actions/workflows/${encodeURIComponent(this.workflow)}/dispatches`, {
      ref: this.branch,
      inputs: { build_id: buildId },
    });
  }

  /** Finds the workflow run whose title contains the build id (null if it has not appeared yet). */
  async findRun(buildId) {
    const data = await this._json(
      'GET',
      `/repos/${this.repo}/actions/workflows/${encodeURIComponent(this.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(this.branch)}&per_page=30`
    );
    const runs = (data && data.workflow_runs) || [];
    return runs.find((r) => String(r.display_title || r.name || '').includes(buildId)) || null;
  }

  getRun(runId) {
    return this._json('GET', `/repos/${this.repo}/actions/runs/${runId}`);
  }

  async getJobs(runId) {
    const data = await this._json('GET', `/repos/${this.repo}/actions/runs/${runId}/jobs`);
    return (data && data.jobs) || [];
  }

  async getJobLogs(jobId) {
    const res = await this._request('GET', `/repos/${this.repo}/actions/jobs/${jobId}/logs`);
    const text = await res.text();
    return text.length > 2_000_000 ? text.slice(-2_000_000) : text;
  }

  async listArtifacts(runId) {
    const data = await this._json('GET', `/repos/${this.repo}/actions/runs/${runId}/artifacts`);
    return (data && data.artifacts) || [];
  }

  async downloadArtifact(artifactId) {
    const res = await this._request('GET', `/repos/${this.repo}/actions/artifacts/${artifactId}/zip`);
    return Buffer.from(await res.arrayBuffer());
  }
}

module.exports = { GitHubClient, GitHubError };
