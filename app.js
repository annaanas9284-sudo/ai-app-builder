(function () {
  'use strict';

  const POLL_MS = window.APP_POLL_MS || 3000;
  const ACTIVE = ['preparing', 'queued', 'building', 'finishing'];
  const app = document.getElementById('app');

  let appConfig = { cloudBuild: { configured: false } };
  let routeToken = 0; // changes on every navigation so late responses from old screens are ignored
  let pollTimer = null;
  let dirtyGuard = null; // set by the editor: returns true while there are unsaved changes
  let toastTimer = null;

  // ---------- tiny helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      throw new Error('Could not reach the app server. Is it still running?');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || 'Something went wrong. Please try again.');
      err.code = data && data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString();
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function render(...nodes) {
    app.replaceChildren(h('div', { class: 'page' }, nodes));
    window.scrollTo(0, 0);
  }

  async function navigate(hash) {
    if (dirtyGuard && dirtyGuard()) {
      const leave = await modal({ title: 'Leave without saving?', text: 'You have changes that are not saved yet.', confirmText: 'Leave', danger: true });
      if (!leave) return;
    }
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  // ---------- modal ----------
  function modal({ title, text, input, confirmText = 'OK', cancelText = 'Cancel', danger = false, onConfirm }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      let busy = false;
      const errorEl = h('p', { class: 'error-text', id: 'modal-error' });
      const inputEl = input
        ? h('input', { type: 'text', id: 'modal-input', value: input.value || '', maxlength: input.maxlength || 100, 'aria-label': input.label })
        : null;
      const confirmBtn = h('button', { class: 'btn ' + (danger ? 'btn-danger-solid' : 'btn-primary'), id: 'modal-confirm', type: 'button' }, confirmText);
      const cancelBtn = h('button', { class: 'btn', id: 'modal-cancel', type: 'button' }, cancelText);
      const overlay = h('div', { class: 'overlay', id: 'modal' },
        h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('h2', { text: title }),
          text ? h('p', { text }) : null,
          inputEl,
          errorEl,
          h('div', { class: 'actions' }, cancelBtn, confirmBtn)));

      function close(result) {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        if (previous && previous.focus) previous.focus();
        resolve(result);
      }
      async function confirm() {
        if (busy) return;
        busy = true;
        confirmBtn.disabled = true;
        errorEl.textContent = '';
        try {
          if (onConfirm) await onConfirm(inputEl ? inputEl.value : undefined);
          close(true);
        } catch (err) {
          errorEl.textContent = err.message;
          busy = false;
          confirmBtn.disabled = false;
          if (inputEl) inputEl.focus();
        }
      }
      function onKey(e) {
        if (e.key === 'Escape') close(false);
        else if (e.key === 'Enter' && inputEl && document.activeElement === inputEl) { e.preventDefault(); confirm(); }
      }
      confirmBtn.addEventListener('click', confirm);
      cancelBtn.addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', onKey);
      document.body.append(overlay);
      (inputEl || confirmBtn).focus();
      if (inputEl) inputEl.select();
    });
  }

  async function renameProject(project) {
    const done = await modal({
      title: 'Rename project',
      input: { value: project.name, label: 'Project name', maxlength: 60 },
      confirmText: 'Save',
      onConfirm: async (value) => {
        const r = await api('PATCH', '/api/projects/' + project.id, { name: value });
        project.name = r.project.name;
      },
    });
    if (done) toast('Renamed');
    return done;
  }

  async function deleteProject(project) {
    const done = await modal({
      title: 'Delete this project?',
      text: `“${project.name}” and its builds will be permanently deleted. This cannot be undone.`,
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => { await api('DELETE', '/api/projects/' + project.id); },
    });
    if (done) toast('Project deleted');
    return done;
  }

  // ---------- screens ----------
  function errorScreen(message, retry) {
    render(
      h('div', { class: 'card' },
        h('h2', { text: 'Something went wrong' }),
        h('p', { class: 'error-text', text: message }),
        h('div', { class: 'actions' },
          retry ? h('button', { class: 'btn btn-primary', onclick: retry }, 'Try again') : null,
          h('button', { class: 'btn', onclick: () => navigate('#/') }, 'Back to My Projects'))));
  }

  async function renderHome() {
    const token = routeToken;
    const heading = h('div', { class: 'top' }, h('div', { class: 'grow' }, h('h1', { text: 'My Projects' }), h('p', { class: 'sub', text: 'Build Android apps in a few taps.' })));
    render(heading, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));

    let projects;
    try {
      projects = (await api('GET', '/api/projects')).projects;
    } catch (err) {
      if (token === routeToken) errorScreen(err.message, renderHome);
      return;
    }
    if (token !== routeToken) return;

    const list = projects.length
      ? projects.map((p) => projectCard(p))
      : [h('div', { class: 'card empty', id: 'empty-state' },
        h('div', { class: 'big', 'aria-hidden': 'true' }, '📱'),
        h('h2', { text: 'No apps yet' }),
        h('p', { text: 'Tap “Create App” to make your first one.' }))];

    render(heading, list);
    app.append(h('div', { class: 'fab-bar' },
      h('button', { class: 'btn btn-primary btn-xl', id: 'create-app-btn', onclick: () => navigate('#/create') }, '＋ Create App')));
  }

  function projectCard(p) {
    let chip = null;
    const b = p.latestBuild;
    if (b && b.status === 'success' && b.apkReady) chip = h('span', { class: 'chip chip-ok' }, 'APK ready');
    else if (b && b.status === 'failed') chip = h('span', { class: 'chip chip-bad' }, 'Last build failed');
    else if (b && ACTIVE.includes(b.status)) chip = h('span', { class: 'chip chip-busy' }, 'Building…');

    return h('article', { class: 'card project-card', 'data-id': p.id },
      h('h3', { class: 'project-name', text: p.name }),
      h('div', { class: 'meta' }, 'Edited ' + timeAgo(p.updatedAt), chip),
      h('div', { class: 'actions', style: 'margin-top:0' },
        h('button', { class: 'btn btn-primary open-btn', onclick: () => navigate('#/project/' + p.id) }, 'Open & Edit'),
        h('button', { class: 'btn rename-btn', onclick: async () => { if (await renameProject(p)) renderHome(); } }, 'Rename'),
        h('button', { class: 'btn btn-danger delete-btn', onclick: async () => { if (await deleteProject(p)) renderHome(); } }, 'Delete')));
  }

  function renderCreate() {
    const nameInput = h('input', { type: 'text', id: 'project-name', maxlength: 60, placeholder: 'e.g. My Cool App', autocomplete: 'off', 'aria-label': 'Project name' });
    const errorEl = h('p', { class: 'error-text', id: 'create-error' });
    const submit = h('button', { class: 'btn btn-primary btn-xl btn-block', id: 'create-submit', type: 'submit' }, 'Create App');

    const form = h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        errorEl.textContent = '';
        submit.disabled = true;
        try {
          const r = await api('POST', '/api/projects', { name: nameInput.value });
          toast('App created');
          location.hash = '#/project/' + r.project.id;
        } catch (err) {
          errorEl.textContent = err.message;
          submit.disabled = false;
          nameInput.focus();
        }
      },
    },
      h('label', { for: 'project-name', text: 'What is your app called?' }),
      nameInput,
      h('p', { class: 'hint', text: 'You can change this later.' }),
      errorEl,
      h('div', { class: 'actions' }, submit));

    render(
      h('div', { class: 'top' },
        h('button', { class: 'btn btn-ghost back-btn', 'aria-label': 'Back', onclick: () => navigate('#/') }, '←'),
        h('div', { class: 'grow' }, h('h1', { text: 'Create App' }))),
      h('div', { class: 'card' }, form));
    nameInput.focus();
  }

  async function renderProject(id) {
    const token = routeToken;
    render(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));

    let project;
    try {
      project = (await api('GET', '/api/projects/' + id)).project;
    } catch (err) {
      if (token !== routeToken) return;
      if (err.status === 404) {
        render(h('div', { class: 'card' },
          h('h2', { text: 'Project not found' }),
          h('p', { class: 'sub', text: 'It may have been deleted.' }),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => navigate('#/') }, 'Back to My Projects'))));
      } else {
        errorScreen(err.message, () => renderProject(id));
      }
      return;
    }
    if (token !== routeToken) return;

    let current = { ...project.config };
    let saved = JSON.stringify(project.config);
    const isDirty = () => JSON.stringify(current) !== saved;
    dirtyGuard = isDirty;

    // --- header ---
    const titleEl = h('h1', { id: 'project-title', text: project.name });
    const header = h('div', { class: 'top' },
      h('button', { class: 'btn btn-ghost back-btn', 'aria-label': 'Back to My Projects', onclick: () => navigate('#/') }, '←'),
      h('div', { class: 'grow' }, titleEl),
      h('button', { class: 'btn btn-small rename-btn', onclick: async () => { if (await renameProject(project)) titleEl.textContent = project.name; } }, 'Rename'));

    // --- editor form ---
    const fields = {};
    const field = (key, label, el, hint) => {
      fields[key] = el;
      el.addEventListener('input', () => { current[key] = el.value; updateDirtyUi(); schedulePreview(); });
      return [h('label', { for: el.id, text: label }), el, hint ? h('p', { class: 'hint', text: hint }) : null];
    };
    const appNameIn = h('input', { type: 'text', id: 'field-appName', maxlength: 30, value: current.appName });
    const headingIn = h('input', { type: 'text', id: 'field-heading', maxlength: 80, value: current.heading });
    const messageIn = h('textarea', { id: 'field-message', maxlength: 500 });
    messageIn.value = current.message;
    const colorIn = h('input', { type: 'color', id: 'field-color', value: current.color });

    const dirtyEl = h('span', { class: 'hint', id: 'dirty-note' });
    const saveErr = h('p', { class: 'error-text', id: 'save-error' });
    const saveBtn = h('button', { class: 'btn btn-primary', id: 'save-btn', onclick: () => save() }, 'Save changes');

    function updateDirtyUi() {
      dirtyEl.textContent = isDirty() ? 'Unsaved changes' : 'All changes saved';
      saveBtn.disabled = !isDirty();
    }

    async function save() {
      saveErr.textContent = '';
      saveBtn.disabled = true;
      try {
        const r = await api('PATCH', '/api/projects/' + id, { config: current });
        project = r.project;
        current = { ...project.config };
        saved = JSON.stringify(project.config);
        appNameIn.value = current.appName;
        headingIn.value = current.heading;
        messageIn.value = current.message;
        colorIn.value = current.color;
        updateDirtyUi();
        toast('Saved');
        return true;
      } catch (err) {
        saveErr.textContent = err.message;
        updateDirtyUi();
        return false;
      }
    }

    const form = h('div', { class: 'card' },
      h('h2', { text: 'Your app' }),
      field('appName', 'App name (shown on the phone)', appNameIn),
      field('heading', 'Heading', headingIn),
      field('message', 'Message', messageIn),
      field('color', 'Background color', colorIn),
      saveErr,
      h('div', { class: 'actions' }, saveBtn, dirtyEl));

    // --- live preview ---
    const frame = h('iframe', { title: 'App preview', sandbox: '', id: 'preview-frame' });
    let previewTimer = null;
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        try {
          const r = await api('POST', '/api/preview', { config: current });
          if (token === routeToken) frame.srcdoc = r.html;
        } catch (_) { /* keep the last good preview while the input is invalid */ }
      }, 250);
    }
    const preview = h('div', { class: 'card' }, h('h2', { text: 'Preview' }), h('div', { class: 'phone' }, frame));

    // --- build ---
    const buildArea = h('div', { id: 'build-area' });
    const buildBtn = h('button', { class: 'btn btn-primary btn-block', id: 'build-btn', onclick: () => startBuild() }, 'Build APK');
    const notice = appConfig.cloudBuild.configured ? null : h('div', { class: 'notice', id: 'cloud-notice' },
      'Cloud build is not set up yet, so the Build button is turned off. Follow steps 2 and 3 in README.md (about 10 minutes). You can still create and edit apps.');
    const exportLink = h('a', { class: 'link', href: '/api/projects/' + id + '/export', download: '', id: 'export-link' }, 'Advanced: download the Android project (.zip)');
    const buildCard = h('div', { class: 'card' },
      h('h2', { text: 'Build APK' }),
      h('p', { class: 'sub', style: 'margin:0 0 12px', text: 'Builds your app in the cloud. This usually takes a few minutes.' }),
      notice, buildBtn, buildArea,
      h('p', { class: 'hint', style: 'margin-top:14px' }, exportLink));

    function renderBuild(build) {
      const active = Boolean(build) && ACTIVE.includes(build.status);
      buildBtn.disabled = active || !appConfig.cloudBuild.configured;
      buildBtn.textContent = active ? 'Building…' : build ? 'Build again' : 'Build APK';

      let box;
      if (!build) {
        box = h('p', { class: 'hint', id: 'no-build', text: 'No build yet.' });
      } else if (active) {
        box = h('div', { class: 'build-box', id: 'build-progress' },
          h('strong', { id: 'build-stage', text: build.stage }),
          h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(build.progress) },
            h('div', { style: `width:${build.progress}%` })),
          h('span', { class: 'hint', id: 'build-percent', text: build.progress + '%' }),
          build.warning ? h('p', { class: 'hint', text: build.warning }) : null,
          build.runUrl ? h('p', { class: 'hint' }, h('a', { class: 'link', href: build.runUrl, target: '_blank', rel: 'noopener' }, 'View on GitHub')) : null);
      } else if (build.status === 'success' && build.apkReady) {
        box = h('div', { class: 'build-box build-ok', id: 'build-success' },
          h('h3', { text: 'Your APK is ready' }),
          h('p', { class: 'hint', text: [formatSize(build.apkSize), 'Built ' + timeAgo(build.finishedAt || build.createdAt)].filter(Boolean).join(' · ') }),
          h('a', { class: 'btn btn-primary', id: 'download-apk', href: '/api/builds/' + build.id + '/apk', download: '' }, 'Download APK'));
      } else {
        const e = build.error || { title: 'The build failed', explanation: 'No more details are available.', suggestions: [], details: '', note: 'Nothing was fixed automatically.' };
        box = h('div', { class: 'build-box build-bad', id: 'build-error', role: 'alert' },
          h('h3', { text: e.title }),
          h('p', { style: 'margin:0', text: e.explanation }),
          e.suggestions && e.suggestions.length ? h('ul', {}, e.suggestions.map((s) => h('li', { text: s }))) : null,
          e.details ? h('details', {}, h('summary', { text: 'Technical details' }), h('pre', { class: 'details', text: e.details })) : null,
          h('p', { class: 'hint', style: 'margin-top:10px', text: e.note || 'Nothing was fixed automatically.' }),
          build.runUrl ? h('p', { class: 'hint' }, h('a', { class: 'link', href: build.runUrl, target: '_blank', rel: 'noopener' }, 'Open the full log on GitHub')) : null);
      }
      buildArea.replaceChildren(box);
    }

    function showStartError(message) {
      buildArea.replaceChildren(h('div', { class: 'build-box build-bad', id: 'build-error', role: 'alert' },
        h('h3', { text: 'Could not start the build' }),
        h('p', { style: 'margin:0', text: message }),
        h('p', { class: 'hint', style: 'margin-top:10px', text: 'Nothing was fixed automatically.' })));
    }

    async function startBuild() {
      if (isDirty() && !(await save())) return;
      buildBtn.disabled = true;
      try {
        const r = await api('POST', `/api/projects/${id}/build`);
        if (token !== routeToken) return;
        renderBuild(r.build);
        if (ACTIVE.includes(r.build.status)) schedulePoll();
      } catch (err) {
        showStartError(err.message);
        buildBtn.disabled = !appConfig.cloudBuild.configured;
      }
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, POLL_MS);
    }
    async function poll() {
      const t = routeToken;
      try {
        const r = await api('GET', `/api/projects/${id}/build`);
        if (t !== routeToken) return;
        renderBuild(r.build);
        if (r.build && ACTIVE.includes(r.build.status)) schedulePoll();
      } catch (err) {
        if (t !== routeToken) return;
        if (err.status === 404) return;
        const stage = document.getElementById('build-stage');
        if (stage) stage.textContent = 'Lost contact with the app server. Retrying…';
        schedulePoll();
      }
    }

    // --- assemble ---
    updateDirtyUi();
    render(header, h('div', { class: 'editor-grid' }, h('div', {}, form, buildCard), preview));
    document.querySelector('.page').classList.add('wide');
    renderBuild(null);
    schedulePreview();

    // show the latest build, and keep watching it if it is still running
    try {
      const r = await api('GET', `/api/projects/${id}/build`);
      if (token !== routeToken) return;
      renderBuild(r.build);
      if (r.build && ACTIVE.includes(r.build.status)) schedulePoll();
    } catch (_) { /* leave "No build yet" */ }
  }

  function renderNotFound() {
    render(h('div', { class: 'card' },
      h('h2', { text: 'Page not found' }),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => navigate('#/') }, 'Back to My Projects'))));
  }

  // ---------- router ----------
  function route() {
    routeToken += 1;
    clearTimeout(pollTimer);
    dirtyGuard = null;
    const hash = location.hash || '#/';
    let m;
    try {
      if (hash === '#/' || hash === '#') renderHome();
      else if (hash === '#/create') renderCreate();
      else if ((m = hash.match(/^#\/project\/([A-Za-z0-9-]+)$/))) renderProject(m[1]);
      else renderNotFound();
    } catch (err) {
      errorScreen(err.message, route);
    }
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => {
    if (dirtyGuard && dirtyGuard()) { e.preventDefault(); e.returnValue = ''; }
  });

  api('GET', '/api/config').then((c) => { appConfig = c; }).catch(() => {}).then(route);
})();
