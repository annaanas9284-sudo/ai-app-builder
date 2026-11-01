"""
Optional browser test: clicks through the real UI on a phone-sized screen.

Needs Python + Playwright (pip install playwright && playwright install chromium).
It starts the app and a PRETEND GitHub itself. It does not need a GitHub account.

    python3 test/e2e/ui_test.py [screenshot_folder]
"""
import os, re, subprocess, sys, tempfile, time, json, urllib.request, urllib.error
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
procs = []


def start(cmd, env_extra, ready_url):
    env = dict(os.environ, **env_extra)
    p = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    procs.append(p)
    for _ in range(100):
        try:
            urllib.request.urlopen(ready_url, timeout=0.5)
            return
        except urllib.error.HTTPError:
            return  # the server answered (an error status is fine for "is it up?")
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("did not start: " + " ".join(cmd))


def api(base, path):
    return json.load(urllib.request.urlopen(base + path))


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=False)


def launch(p):
    try:
        return p.chromium.launch()
    except Exception:
        return p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])


def new_page(browser, base):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
    ctx.add_init_script("window.APP_POLL_MS = 300;")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # The browser logs every 4xx answer as a console error. The app answers 400 on purpose when
    # a name is empty (and these tests do that deliberately), so only unexpected errors count.
    page.on("console", lambda m: errors.append(m.text)
            if m.type == "error" and "status of 400" not in m.text else None)
    page.goto(base)
    return page, errors


def run():
    tmp = tempfile.mkdtemp(prefix="aab-e2e-")
    # 1) app WITHOUT cloud build
    start(["node", "server.js"], {"PORT": "3101", "DATA_DIR": tmp + "/a", "GITHUB_TOKEN": "", "GITHUB_REPO": ""}, "http://127.0.0.1:3101/api/config")
    # 2) pretend GitHub (success) + app WITH cloud build
    start(["node", "test/fake-github.js"], {"PORT": "4010", "SCENARIO": "success"}, "http://127.0.0.1:4010/")  # 404 is fine
    start(["node", "server.js"], {"PORT": "3102", "DATA_DIR": tmp + "/b", "GITHUB_TOKEN": "test-token", "GITHUB_REPO": "owner/repo", "GITHUB_API_URL": "http://127.0.0.1:4010"}, "http://127.0.0.1:3102/api/config")
    # 3) pretend GitHub (compile error) + app
    start(["node", "test/fake-github.js"], {"PORT": "4011", "SCENARIO": "failure-compile"}, "http://127.0.0.1:4011/")
    start(["node", "server.js"], {"PORT": "3103", "DATA_DIR": tmp + "/c", "GITHUB_TOKEN": "test-token", "GITHUB_REPO": "owner/repo", "GITHUB_API_URL": "http://127.0.0.1:4011"}, "http://127.0.0.1:3103/api/config")

    A, B, C = "http://127.0.0.1:3101", "http://127.0.0.1:3102", "http://127.0.0.1:3103"
    results = []

    def ok(msg):
        results.append(msg)
        print("PASS  " + msg)

    with sync_playwright() as p:
        browser = launch(p)

        # ---------- A: projects, create, edit, rename, delete (no cloud build) ----------
        page, errors = new_page(browser, A)
        expect(page.locator("#create-app-btn")).to_be_visible()
        expect(page.locator("#empty-state")).to_be_visible()
        shot(page, "1-home-empty")
        ok("Home shows a prominent Create App button and an empty state")

        page.click("#create-app-btn")
        expect(page.locator("#project-name")).to_be_visible()
        page.click("#create-submit")  # empty name
        expect(page.locator("#create-error")).to_contain_text("enter a name")
        ok("Creating with an empty name shows a clear message")

        page.fill("#project-name", "My Test App")
        page.click("#create-submit")
        page.wait_for_url(re.compile(r"#/project/[\w-]+$"))
        expect(page.locator("#project-title")).to_have_text("My Test App")
        pid = page.url.split("/")[-1]
        assert api(A, "/api/projects")["projects"][0]["name"] == "My Test App"
        ok("Create App button creates and saves a project, then opens it")

        page.fill("#field-heading", "Hello Playwright")
        expect(page.locator("#dirty-note")).to_have_text("Unsaved changes")
        page.fill("#field-message", "Edited message")
        page.fill("#field-appName", "Edited App")
        page.wait_for_function("document.getElementById('preview-frame').srcdoc.includes('Hello Playwright')")
        ok("Editing updates the live preview")
        shot(page, "2-editor")
        page.click("#save-btn")
        expect(page.locator("#dirty-note")).to_have_text("All changes saved")
        cfg = api(A, "/api/projects/" + pid)["project"]["config"]
        assert cfg["heading"] == "Hello Playwright" and cfg["message"] == "Edited message" and cfg["appName"] == "Edited App", cfg
        ok("Save button saves the edits to the server")

        expect(page.locator("#build-btn")).to_be_disabled()
        expect(page.locator("#cloud-notice")).to_be_visible()
        expect(page.locator("#download-apk")).to_have_count(0)
        ok("Without cloud setup: Build is disabled with an explanation and there is no download button")

        page.click(".top .rename-btn")
        page.fill("#modal-input", "Renamed In Editor")
        page.click("#modal-confirm")
        expect(page.locator("#project-title")).to_have_text("Renamed In Editor")
        ok("Rename button works inside the editor")

        page.click(".back-btn")
        card = page.locator(".project-card")
        expect(card).to_have_count(1)
        expect(card.locator(".project-name")).to_have_text("Renamed In Editor")
        shot(page, "3-home-with-project")

        card.locator(".rename-btn").click()
        page.fill("#modal-input", "")
        page.click("#modal-confirm")
        expect(page.locator("#modal-error")).to_contain_text("enter a name")
        page.fill("#modal-input", "Final Name")
        page.press("#modal-input", "Enter")
        expect(page.locator(".project-card .project-name")).to_have_text("Final Name")
        assert api(A, "/api/projects")["projects"][0]["name"] == "Final Name"
        ok("Rename button (list) validates and saves")

        page.reload()
        expect(page.locator(".project-card .project-name")).to_have_text("Final Name")
        ok("Project is still there after reloading the page")

        page.locator(".project-card .open-btn").click()
        expect(page.locator("#field-heading")).to_have_value("Hello Playwright")
        ok("Open & Edit button reopens the project with the saved edits")
        page.click(".back-btn")

        page.locator(".delete-btn").click()
        page.click("#modal-cancel")
        expect(page.locator(".project-card")).to_have_count(1)
        page.locator(".delete-btn").click()
        page.click("#modal-confirm")
        expect(page.locator("#empty-state")).to_be_visible()
        assert api(A, "/api/projects")["projects"] == []
        ok("Delete asks first (Cancel keeps it), then deletes for real")
        assert not errors, errors

        # ---------- B: successful cloud build (pretend GitHub) ----------
        page, errors = new_page(browser, B)
        page.click("#create-app-btn")
        page.fill("#project-name", "Build Me")
        page.click("#create-submit")
        page.wait_for_url(re.compile(r"#/project/[\w-]+$"))
        expect(page.locator("#build-btn")).to_be_enabled()
        expect(page.locator("#download-apk")).to_have_count(0)
        page.click("#build-btn")
        expect(page.locator("#build-progress")).to_be_visible()
        shot(page, "4-building")
        expect(page.locator("#download-apk")).to_have_count(0)
        expect(page.locator("#build-success")).to_be_visible(timeout=15000)
        expect(page.locator("#download-apk")).to_be_visible()
        shot(page, "5-build-success")
        with page.expect_download() as d:
            page.click("#download-apk")
        path = d.value.path()
        assert open(path, "rb").read(2) == b"PK"
        ok("Build APK button: progress shown, Download APK appears only after success and downloads a file")
        page.reload()
        expect(page.locator("#download-apk")).to_be_visible()
        page.click(".back-btn")
        expect(page.locator(".chip-ok")).to_have_text("APK ready")
        ok("Build result is remembered after reload and shown on the project card")
        assert not errors, errors

        # ---------- C: failed cloud build ----------
        page, errors = new_page(browser, C)
        page.click("#create-app-btn")
        page.fill("#project-name", "Break Me")
        page.click("#create-submit")
        page.wait_for_url(re.compile(r"#/project/[\w-]+$"))
        page.click("#build-btn")
        expect(page.locator("#build-error")).to_be_visible(timeout=15000)
        expect(page.locator("#build-error")).to_contain_text("The app code did not compile")
        expect(page.locator("#build-error")).to_contain_text("not been fixed automatically")
        expect(page.locator("#download-apk")).to_have_count(0)
        page.locator("#build-error summary").click()
        expect(page.locator("#build-error pre")).to_contain_text("cannot find symbol")
        shot(page, "6-build-failed")
        expect(page.locator("#build-btn")).to_have_text("Build again")
        expect(page.locator("#build-btn")).to_be_enabled()
        page.click(".back-btn")
        expect(page.locator(".chip-bad")).to_have_text("Last build failed")
        ok("Failed build: error + plain explanation + technical details shown, no download, can build again")
        assert not errors, errors

        browser.close()
    print("\nALL %d UI CHECKS PASSED" % len(results))


try:
    run()
finally:
    for pr in procs:
        pr.terminate()
