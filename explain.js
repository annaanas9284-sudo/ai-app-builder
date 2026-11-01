'use strict';
// Turns raw build failures into short, plain explanations.
// These are best-effort READINGS of the log. Nothing is ever fixed automatically.

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

function cleanLines(logText) {
  return String(logText || '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.replace(TIMESTAMP, '').trimEnd())
    .filter((l) => l.length > 0);
}

/** Picks the lines of a log that most likely describe the error. */
function extractErrorLines(logText, maxChars = 4000) {
  const lines = cleanLines(logText);
  if (!lines.length) return '';
  let picked = [];

  const wrongIdx = lines.map((l) => /What went wrong:/.test(l)).lastIndexOf(true);
  if (wrongIdx >= 0) picked = lines.slice(wrongIdx, wrongIdx + 14);

  const errorLines = lines.filter((l) => /(^|\s)(error:|ERROR:|FAILURE:|Caused by:|FAILED)/.test(l));
  for (const l of errorLines.slice(0, 15)) if (!picked.includes(l)) picked.push(l);

  if (!picked.length) picked = lines.slice(-30);
  let text = picked.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…';
  return text;
}

const PATTERNS = [
  {
    test: /SDK location not found|ANDROID_HOME|ANDROID_SDK_ROOT/i,
    title: 'The Android SDK was not found on the build machine',
    explanation: 'The cloud build machine could not find the Android SDK it needs to compile an app.',
    suggestions: ['Run the build again. This is usually a problem on the build machine, not with your app.', 'Check the workflow file in your GitHub repository was not changed.'],
  },
  {
    test: /Could not (resolve|GET|download)|Connection (reset|timed out)|UnknownHostException|Read timed out|Network is unreachable/i,
    title: 'A download needed for the build failed',
    explanation: 'The build tried to download a required tool or library and could not. This is usually a temporary network problem.',
    suggestions: ['Wait a minute and press “Build again”.', 'If it keeps happening, check https://www.githubstatus.com for outages.'],
  },
  {
    test: /Unsupported class file major version|requires Java|Unsupported Java|JAVA_HOME|invalid source release|invalid target release/i,
    title: 'The Java version does not match',
    explanation: 'The Android tools and the Java version on the build machine do not agree. The workflow expects Java 17.',
    suggestions: ['Check that .github/workflows/build-apk.yml still uses Java 17 and Gradle 8.9.'],
  },
  {
    test: /package name .*(invalid|not valid)|not a valid (Java )?(identifier|package)|Invalid package|Namespace .* is not a valid/i,
    title: 'The app’s package name was rejected',
    explanation: 'Android refused the app’s internal package name (its unique ID, like com.example.myapp).',
    suggestions: ['Create a new project with a simple name (letters and numbers) and try again.'],
  },
  {
    test: /AAPT|resource linking failed|Android resource (compilation|linking)|error: .*(string|values)\/|strings\.xml/i,
    title: 'An app resource could not be processed',
    explanation: 'Android could not process one of the app’s resources. This is often caused by an unusual character in the app name.',
    suggestions: ['Edit the app and use only letters, numbers and spaces in the “App name” field, then build again.'],
  },
  {
    test: /cannot find symbol|compileDebugJavaWithJavac|error: (illegal start|class, interface|';' expected)|Compilation failed/i,
    title: 'The app code did not compile',
    explanation: 'The Android compiler found a problem in the app’s code while building it.',
    suggestions: ['Open the technical details below and look for the first line starting with “error:”.', 'If you have not changed the generated project, please report this problem together with those details.'],
  },
  {
    test: /No space left on device/i,
    title: 'The build machine ran out of disk space',
    explanation: 'The cloud machine ran out of storage during the build.',
    suggestions: ['Run the build again.'],
  },
  {
    test: /invalid build id|build file .* could not|The build description is not valid/i,
    title: 'The build request was not valid',
    explanation: 'The cloud build could not read the build description that the app builder uploaded.',
    suggestions: ['Check your app settings (app name, text, color), save, and build again.'],
  },
];

const STEP_FALLBACKS = [
  [/check out/i, 'The project files could not be downloaded to the build machine', 'GitHub could not check out your repository on the build machine.'],
  [/prepare android/i, 'The Android project could not be prepared', 'The step that turns your app into an Android project failed.'],
  [/java/i, 'Java could not be set up', 'The build machine could not set up Java.'],
  [/gradle/i, 'Gradle could not be set up', 'The build machine could not set up Gradle, the Android build tool.'],
  [/build apk/i, 'The Android build failed', 'Gradle (the Android build tool) stopped with an error while building your APK.'],
  [/save apk|upload/i, 'The APK could not be saved', 'The build ran, but its APK file could not be saved for download.'],
];

const NOTE = 'This is the most likely cause based on the build log. It has not been fixed automatically.';

/** conclusion: 'failure' | 'cancelled' | 'timed_out' | … */
function explainFailure({ stepName, logText, conclusion }) {
  const details = extractErrorLines(logText);
  // Only look at the lines that describe the error, so unrelated warnings earlier in the log do not confuse the reading.
  const haystack = details || String(logText || '').slice(-3000);

  if (conclusion === 'cancelled') {
    return { title: 'The build was cancelled', explanation: 'The build was stopped before it finished (it may have been cancelled on GitHub).', suggestions: ['Press “Build again” to start a new build.'], details, note: NOTE };
  }
  if (conclusion === 'timed_out') {
    return { title: 'The build took too long', explanation: 'The build ran out of time and was stopped by GitHub.', suggestions: ['Press “Build again”. If it keeps happening, check the build log on GitHub.'], details, note: NOTE };
  }

  for (const p of PATTERNS) {
    if (p.test.test(haystack)) {
      return { title: p.title, explanation: p.explanation + (stepName ? ` It stopped during the step “${stepName}”.` : ''), suggestions: p.suggestions, details, note: NOTE };
    }
  }
  for (const [re, title, explanation] of STEP_FALLBACKS) {
    if (stepName && re.test(stepName)) {
      return { title, explanation, suggestions: ['Open the technical details below.', 'Press “Build again” in case it was a temporary problem.'], details, note: NOTE };
    }
  }
  return {
    title: 'The build failed',
    explanation: stepName ? `The build stopped during the step “${stepName}”, and the log did not clearly show why.` : 'The build stopped, and the log did not clearly show why.',
    suggestions: ['Open the technical details below.', 'Press “Build again” in case it was a temporary problem.'],
    details,
    note: NOTE,
  };
}

/** Problems talking to GitHub (before or during a build). */
function explainGitHubError(err) {
  const status = err && err.status;
  const raw = (err && err.message) || 'Unknown error';
  const base = (title, explanation, suggestions) => ({ title, explanation, suggestions, details: raw, note: 'Nothing was fixed automatically.' });

  if (err && err.kind === 'network') {
    return base('Could not reach GitHub', 'This computer could not connect to GitHub, so the build could not start or be checked.', ['Check your internet connection and try again.']);
  }
  if (status === 401) {
    return base('GitHub did not accept your token', 'The access token in your .env file is wrong, expired or revoked.', ['Create a new token (see the setup instructions, step 2), put it in .env as GITHUB_TOKEN, and restart the app.']);
  }
  if (status === 403) {
    return base('GitHub refused the request', 'The token is valid but is not allowed to do this, or GitHub is limiting requests.', ['Make sure the token has “Contents: Read and write” and “Actions: Read and write” permission for your repository.', 'If you just built many times, wait a few minutes.']);
  }
  if (status === 404) {
    return base('GitHub could not find the repository or workflow', 'The repository, branch or workflow named in your .env file was not found, or the token cannot see it.', ['Check GITHUB_REPO (owner/name), GITHUB_BRANCH and GITHUB_WORKFLOW in .env.', 'Make sure this project, including the .github/workflows/build-apk.yml file, has been pushed to that repository.']);
  }
  if (status === 422) {
    return base('GitHub could not start the workflow', 'GitHub says the workflow cannot be started. This usually means the workflow file is missing from the branch.', ['Push the whole project (including .github/workflows/build-apk.yml) to the branch named in GITHUB_BRANCH.']);
  }
  return base('GitHub returned an error', 'GitHub reported a problem while starting or checking the build.', ['Try again in a minute.']);
}

module.exports = { explainFailure, explainGitHubError, extractErrorLines };
