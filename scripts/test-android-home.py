#!/usr/bin/env python3
"""Exercise both Android entry points on an explicitly selected disposable emulator."""

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

PACKAGE = "dk.madsbuch.hjem"
COMPONENT = PACKAGE + "/.MainActivity"
MAIN = "android.intent.action.MAIN"
HOME = "android.intent.category.HOME"
LAUNCHER = "android.intent.category.LAUNCHER"
COMPONENT_PATTERN = r"dk\.madsbuch\.hjem/(?:\.MainActivity|dk\.madsbuch\.hjem\.MainActivity)"
RECORD_PATTERN = re.compile(r"\* Hist\s+#\d+: ActivityRecord\{(\w+) u\d+ " + COMPONENT_PATTERN + r"\s")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True, help="Disposable, unlocked emulator (emulator-NNNN)")
    parser.add_argument("--apk", type=Path, help="Install/update this APK; never uninstalls or clears app data")
    parser.add_argument("--adb", help="ADB binary; otherwise use PATH or the Android SDK")
    parser.add_argument("--output-dir", type=Path, help="Screenshots, hierarchies, task dumps, and logs")
    args = parser.parse_args()
    if not re.fullmatch(r"emulator-\d+", args.serial):
        parser.error("Use a disposable emulator, not a physical device.")
    if args.apk and not args.apk.is_file():
        parser.error("APK does not exist: " + str(args.apk))
    sdk = Path(os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or Path.home() / "Library/Android/sdk")
    adb = args.adb or shutil.which("adb") or str(sdk / "platform-tools/adb")
    output = (args.output_dir or Path(__file__).resolve().parent.parent / "test-results/android-home" /
              (time.strftime("%Y%m%d-%H%M%S") + "-" + str(os.getpid()))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    remote_xml = "/data/local/tmp/hjem-home-" + str(os.getpid()) + ".xml"
    original_home = None
    launcher_component = None
    phase = "preflight"

    def run(*arguments, binary=False, allow_failure=False):
        result = subprocess.run([adb, "-s", args.serial, *arguments], capture_output=True, timeout=30)
        if result.returncode and not allow_failure:
            raise RuntimeError("ADB failed: " + " ".join(arguments) + "\n" +
                               result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace"))
        return result.stdout if binary else result.stdout.decode(errors="replace").strip()

    def components(text):
        return re.findall(r"^\s*([\w.]+/[\w.$]+)\s*$", text, re.MULTILINE)

    def set_home(component):
        response = run("shell", "cmd", "package", "set-home-activity", component)
        if "Success" not in response:
            raise RuntimeError("Could not set test home: " + response)

    def start_app():
        if launcher_component is None:
            raise RuntimeError("Hjem's app-icon entry point was not resolved.")
        response = run("shell", "am", "start", "-W", "-a", MAIN, "-c", LAUNCHER, "-n", launcher_component)
        if "Error:" in response or "Exception" in response:
            raise RuntimeError(response)

    def background():
        response = run("shell", "am", "start", "-W", "-a", "android.settings.SETTINGS")
        if "Error:" in response or "Exception" in response:
            raise RuntimeError(response)
        # Hjem must not already be topmost: Android can reuse it in that case,
        # concealing the distinct STANDARD/HOME task bug.
        tasks = run("shell", "dumpsys", "activity", "activities")
        if not re.search(r"(?:topResumedActivity|mResumedActivity)=.*com\.android\.settings/", tasks):
            raise RuntimeError("Android Settings did not take the foreground.")

    def foreground(expected=None):
        deadline = time.monotonic() + 20
        while True:
            tasks = run("shell", "dumpsys", "activity", "activities")
            (output / (phase + "-activities.txt")).write_text(tasks)
            # Force-stop leaves finishing records behind until the closing
            # animation completes. They are no longer live activity instances.
            blocks = re.split(r"(?=^\s*\* Hist\s+#\d+: ActivityRecord\{)", tasks, flags=re.MULTILINE)
            records = {match.group(1) for block in blocks
                       if (match := RECORD_PATTERN.search(block)) and "finishing=true" not in block}
            if len(records) > 1:
                raise AssertionError("Duplicate Hjem activities: " + ", ".join(sorted(records)))
            resumed = re.search(r"(?:topResumedActivity|mResumedActivity)=ActivityRecord\{(\w+) u\d+ " + COMPONENT_PATTERN + r"\s", tasks)
            if resumed and records == {resumed.group(1)}:
                pid = run("shell", "pidof", PACKAGE)
                if not pid:
                    raise AssertionError("Hjem process is missing.")
                current = (resumed.group(1), pid)
                if expected and current != expected:
                    raise AssertionError("Hjem activity/process changed: " + repr(expected) + " -> " + repr(current))
                return current
            if time.monotonic() >= deadline:
                raise AssertionError("Hjem did not become the only foreground Hjem activity.")
            time.sleep(0.2)

    def capture():
        (output / (phase + ".png")).write_bytes(run("exec-out", "screencap", "-p", binary=True))
        # Some emulator images terminate the dumper after it writes successfully.
        # Validate a newly written hierarchy instead of trusting its exit code.
        run("shell", "rm", "-f", remote_xml)
        dump = run("shell", "uiautomator", "dump", remote_xml, allow_failure=True)
        (output / (phase + "-dump.txt")).write_text(dump)
        xml = run("shell", "cat", remote_xml)
        (output / (phase + ".xml")).write_text(xml)
        return ET.fromstring(xml)

    def visible(expected=None):
        identity = foreground(expected)
        deadline = time.monotonic() + 20
        while True:
            hierarchy = capture()
            if any(node.get("package") == PACKAGE and node.get("class") == "android.webkit.WebView" and
                   node.get("bounds") not in (None, "[0,0][0,0]") for node in hierarchy.iter("node")):
                # Android may expose a native WebView and a nested accessibility
                # WebView node. Presence matters; exactly-one is not a valid check.
                print("PASS", phase, "activity=" + identity[0], "pid=" + identity[1], flush=True)
                return identity
            if time.monotonic() >= deadline:
                raise AssertionError("Foreground Hjem has no visible WebView.")
            time.sleep(0.2)

    failed = False
    try:
        if run("get-state") != "device" or run("shell", "getprop", "ro.kernel.qemu") != "1":
            raise RuntimeError("Selected device is not an online Android emulator.")
        if run("shell", "getprop", "sys.boot_completed") != "1":
            raise RuntimeError("Wait for the emulator to finish booting.")
        resolved = components(run("shell", "cmd", "package", "resolve-activity", "--brief", "-a", MAIN, "-c", HOME))
        if len(resolved) != 1 or "ResolverActivity" in resolved[0]:
            raise RuntimeError("Choose a default home app on the test emulator before running.")
        original_home = resolved[0]
        alternatives = components(run("shell", "cmd", "package", "query-activities", "--brief", "-a", MAIN, "-c", HOME))
        stock_home = next((value for value in alternatives if not value.startswith(PACKAGE + "/") and "FallbackHome" not in value), None)
        if not stock_home:
            raise RuntimeError("The test emulator needs another launcher besides Hjem.")
        if args.apk:
            print(run("install", "-r", str(args.apk.resolve())), flush=True)
        if not run("shell", "pm", "path", PACKAGE).startswith("package:"):
            raise RuntimeError("Hjem is not installed. Supply --apk.")
        launcher_entries = components(run("shell", "cmd", "package", "resolve-activity", "--brief",
                                          "-a", MAIN, "-c", LAUNCHER, "-p", PACKAGE))
        if len(launcher_entries) != 1 or not launcher_entries[0].startswith(PACKAGE + "/"):
            raise RuntimeError("Could not resolve Hjem's app-icon entry point.")
        launcher_component = launcher_entries[0]
        run("shell", "wm", "dismiss-keyguard")
        print("Evidence:", output, flush=True)

        for order in ("app-first", "home-first"):
            phase = order + "-cold-start"
            set_home(stock_home)
            run("shell", "am", "force-stop", PACKAGE)
            run("shell", "input", "keyevent", "KEYCODE_HOME")
            if order == "app-first":
                start_app()
            else:
                set_home(COMPONENT)
                run("shell", "input", "keyevent", "KEYCODE_HOME")
            identity = visible()
            if order == "app-first":
                current_home = components(run("shell", "cmd", "package", "resolve-activity", "--brief", "-a", MAIN, "-c", HOME))
                if current_home != [stock_home]:
                    raise AssertionError("Opening the app changed the default home app.")
                phase = order + "-stock-home"
                run("shell", "input", "keyevent", "KEYCODE_HOME")
                deadline = time.monotonic() + 20
                while True:
                    tasks = run("shell", "dumpsys", "activity", "activities")
                    (output / (phase + "-activities.txt")).write_text(tasks)
                    stock_package = re.escape(stock_home.split("/")[0])
                    if re.search(r"(?:topResumedActivity|mResumedActivity)=ActivityRecord\{\w+ u\d+ " + stock_package + "/", tasks):
                        break
                    if time.monotonic() >= deadline:
                        raise AssertionError("Home did not return to the user's default launcher.")
                    time.sleep(0.2)
                phase = order + "-reopen"
                start_app()
                visible(identity)
            background()
            set_home(COMPONENT)
            phase = order + "-other-entry"
            if order == "app-first":
                run("shell", "input", "keyevent", "KEYCODE_HOME")
            else:
                start_app()
            visible(identity)
            for cycle in range(1, 6):
                phase = order + "-home-return-" + str(cycle)
                background()
                run("shell", "input", "keyevent", "KEYCODE_HOME")
                foreground(identity)
            visible(identity)
        print("Android home regression passed: both launch orders and ten Home returns.", flush=True)
    except (AssertionError, RuntimeError, subprocess.SubprocessError, OSError, ET.ParseError) as error:
        failed = True
        print("FAIL", phase + ":", error, file=sys.stderr, flush=True)
        try:
            capture()
        except Exception as capture_error:
            print("Could not capture failure:", capture_error, file=sys.stderr)
    finally:
        if original_home:
            for label, action in (
                ("collect logs", lambda: (output / "logcat.txt").write_text(run("logcat", "-d", "-v", "threadtime"))),
                ("restore home", lambda: set_home(original_home)),
                ("stop Hjem", lambda: run("shell", "am", "force-stop", PACKAGE)),
                ("remove temporary hierarchy", lambda: run("shell", "rm", "-f", remote_xml)),
            ):
                try:
                    action()
                except Exception as cleanup_error:
                    failed = True
                    print("Could not " + label + ":", cleanup_error, file=sys.stderr)
        print("Evidence:", output, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
