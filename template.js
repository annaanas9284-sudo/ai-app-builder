'use strict';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The default settings for a brand-new app. */
function defaultConfig(name) {
  return {
    appName: name.slice(0, 30),
    heading: 'Hello from ' + name.slice(0, 40) + '!',
    message: 'This is your new app. Open it in the app builder to change this text.',
    color: '#5b5bd6',
  };
}

/** Turns app settings into the single HTML screen that is packaged inside the Android app. */
function renderHomePage(config) {
  const message = esc(config.message).replace(/\n/g, '<br>');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.appName)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #fff;
    background: linear-gradient(160deg, ${esc(config.color)} 0%, #111827 100%);
    display: flex; align-items: center; justify-content: center;
    padding: 24px; text-align: center;
  }
  main { max-width: 480px; }
  h1 { font-size: 2rem; margin: 0 0 16px; line-height: 1.2; }
  p { font-size: 1.1rem; line-height: 1.5; margin: 0; opacity: .92; }
</style>
</head>
<body>
<main>
  <h1>${esc(config.heading)}</h1>
  <p>${message}</p>
</main>
</body>
</html>
`;
}

module.exports = { renderHomePage, defaultConfig, esc };
