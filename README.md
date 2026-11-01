# AI App Builder

Create simple Android apps on your phone or computer, save them, and build an installable
**APK** in the cloud (using GitHub Actions — free for most personal use).

> **Version note:** this version has **no AI features**. AI app generation, AI chat and automatic
> error fixing are planned for a future update. The code is organised so they can be added later
> (see "Where AI will plug in" at the bottom).

## What it does

| Feature | How it works |
|---|---|
| **Create App** | Tap the big *Create App* button, type a name, done. The project is saved to disk immediately. |
| **My Projects** | Lists every project. *Open & Edit*, *Rename* and *Delete* (asks first) are on each card. |
| **Edit** | Change the app name, heading, message and background colour. A live preview updates as you type. *Save changes* saves. |
| **Build APK** | Sends the project to a GitHub Actions build. Progress bar and stage names come from GitHub's real status. |
| **Download APK** | Appears **only** after the build really succeeded and the APK file was downloaded and checked. |
| **Errors** | If a build fails, you see a plain-English explanation plus the real technical log lines. Nothing is ever claimed to be fixed automatically. |

---

## Honest status of testing

* ✅ Automated tests (19 server tests + 14 click-through browser checks) pass. They cover creating,
  saving, renaming, deleting, editing, reloading, build progress, success and failure screens.
* ⚠️ Those tests use a **pretend GitHub**. They prove the app handles builds correctly, but they do
  **not** prove that Gradle produces a working APK.
* ⚠️ **The real Android build (`.github/workflows/build-apk.yml`) has not been run yet.** It could not
  be run where this project was written (no access to Google's Android download servers).
  **Your first real build is the real test.** If it fails, the app will show you the real error —
  and please don't assume it works until you have installed an APK it produced.

---

## Setup (about 10–15 minutes, no coding)

You need: a computer with **Node.js 18 or newer** (download from https://nodejs.org — choose "LTS"),
and a free **GitHub account** (https://github.com).

### Step 1 — Run the app (no cloud build yet)

1. Unzip this project.
2. Open a terminal / command prompt **inside the folder** (the one that contains `server.js`).
3. Run: `npm start`
4. Open **http://localhost:3000** in your browser.

You can already create, edit, rename and delete projects. The *Build APK* button will say that
cloud build is not set up yet. To enable it, continue with steps 2 and 3.

To stop the app press `Ctrl + C`. Your projects are kept in the `data/` folder.

### Step 2 — Put this project on GitHub (this is where APKs get built)

1. On GitHub click **New repository**. Name it e.g. `my-app-builds`. Choose **Private**. Create it.
2. Upload this project's files to it. Easiest way, in the terminal inside the project folder:
   ```
   git init
   git add .
   git commit -m "First commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/my-app-builds.git
   git push -u origin main
   ```
   (Make sure the hidden folder `.github/workflows/build-apk.yml` was uploaded. Open the **Actions**
   tab on GitHub: you should see a workflow called **Build APK**.)

### Step 3 — Give the app permission to start builds

1. On GitHub: your profile picture → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. *Repository access*: **Only select repositories** → choose your repository.
3. *Permissions → Repository permissions*: set **Contents: Read and write** and
   **Actions: Read and write**. (Nothing else.)
4. Generate the token and copy it (you only see it once).
5. In the project folder, copy `.env.example` to a new file named `.env` and fill in:
   ```
   GITHUB_TOKEN=the-token-you-copied
   GITHUB_REPO=YOUR-NAME/my-app-builds
   ```
6. Stop (`Ctrl + C`) and start (`npm start`) the app again. The terminal should now say
   **Cloud build: ON**.

### Step 4 — Build your first APK

1. Create an app, press **Build APK**.
2. Watch the progress. A first build usually takes a few minutes.
3. When it really succeeds, **Download APK** appears. Copy the file to your Android phone and open it.
   Android will ask you to allow installing from this source — that is normal for apps that are
   not from the Play Store.

The APK is a **debug** build (signed with a debug key). It is fine for testing and personal use but
cannot be uploaded to the Google Play Store as is.

---

## Settings (`.env`)

| Setting | Meaning | Default |
|---|---|---|
| `GITHUB_TOKEN` | Token from step 3 | *(empty = cloud build off)* |
| `GITHUB_REPO` | `owner/repository` | *(empty = cloud build off)* |
| `GITHUB_BRANCH` | Branch that has the workflow | `main` |
| `PORT` | Port of the app | `3000` |
| `HOST` | `127.0.0.1` = only this computer. Use `0.0.0.0` to open it from your phone on the same Wi-Fi. | `127.0.0.1` |
| `DATA_DIR` | Where projects are saved | `./data` |

**Keep your token private.** `.env` is excluded from git by `.gitignore`. Anyone who can open the app
in a browser can use your token to start builds, so only expose it (`HOST=0.0.0.0`) on a network you trust.

## Troubleshooting

| You see | Usually means |
|---|---|
| "Cloud build is not set up yet" | `.env` missing or incomplete, or the app was not restarted. |
| "GitHub did not start the build" | The workflow isn't on the branch named in `GITHUB_BRANCH`, or Actions is disabled in the repo. |
| Token / permission message | Re-create the token with the two permissions from step 3 and for the right repository. |
| Build failed with technical details | Read the explanation and the first `error:` line in *Technical details*. The app only explains; it does not change anything. "Open the full log on GitHub" shows everything. |

## Running the tests

```
npm test                      # server and build-logic tests (pretend GitHub, no internet needed)
python3 test/e2e/ui_test.py   # optional: clicks through the real UI (pip install playwright; playwright install chromium)
```

## Project layout

```
server.js                    web server + API
lib/                         projects storage, validation, Android project generation, build manager, error explanations
lib/generators/index.js      EMPTY extension point for future AI (not connected to anything)
public/                      the mobile-friendly web interface
android-template/            the Android project every app is based on (a WebView showing your app screen)
scripts/prepare-android.js   used by the cloud build to create the Android project
.github/workflows/build-apk.yml   the cloud build
builds/                      build requests are written here (in the GitHub repo) for the workflow to read
test/                        automated tests
```

## Where AI will plug in (not implemented)

* `lib/generators/index.js` describes the planned hook: a generator returns `{ name, config }`, the
  same shape the editor already saves. Saving, preview and building then work unchanged.
* Every project has a `source` field (`"manual"` today) so generated projects can be told apart later.
* There is no AI code, no Claude API call, no chat and no automatic error fixing in this version.
