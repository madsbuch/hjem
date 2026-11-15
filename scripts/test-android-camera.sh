#!/usr/bin/env bash
# Runs a standalone UI test against an installed, non-debuggable Hjem APK.
# It revokes/regrants camera permission and restarts Hjem; it does not clear app data.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERIAL=""
APK=""
BUILD_ONLY=false
OUTPUT_DIR=""
TEST_TIMEOUT=180

usage() {
  cat <<'HELP'
Usage: scripts/test-android-camera.sh --serial DEVICE [--apk release.apk] [--output-dir DIR]
       scripts/test-android-camera.sh --build-only [--output-dir DIR]
       scripts/test-android-camera.sh --check-output instrumentation.log

Use an unlocked test emulator with front and back cameras and an English app UI.
--apk installs/updates the supplied release APK. Without it, tests the installed APK.
The device is not reset, and mismatched signing keys are never bypassed by uninstalling.
Do not run another UI automation session on the same device at the same time.

Requires Android SDK platform android-35 (android.jar, uiautomator.jar and
optional/android.test.base.jar), build-tools, platform-tools, and a JDK.
Overrides: ANDROID_HOME / ANDROID_SDK_ROOT, JAVA_HOME, ANDROID_PLATFORM,
ANDROID_BUILD_TOOLS, TEST_TIMEOUT_SECONDS (default 180).
Evidence is written to test-results/android-camera/<timestamp>-<pid> by default.
HELP
}

fail() { echo "Error: $*" >&2; exit 1; }

check_output() {
  local log="$1"
  [[ -f "$log" ]] || { echo "Missing instrumentation log: $log" >&2; return 1; }
  # `adb shell uiautomator` can exit zero even when JUnit or the runner fails.
  # The legacy runner ends even a successful run with STATUS_CODE -1.
  # Exceptions can also print OK, so reject their diagnostics before the summary.
  if grep -Eq 'FAILURES!!!|INSTRUMENTATION_(FAILED|ABORTED)|INSTRUMENTATION_(STATUS|RESULT): (Error|stack|shortMsg|longMsg)=|INSTRUMENTATION_STATUS_CODE: -([2-9]|[0-9]{2,})|(^|[[:space:]])(Exception|Error) in thread' "$log"; then
    echo "Android camera test reported a failure. See $log" >&2
    return 1
  fi
  if ! grep -Eq '^OK \(1 test\)[[:space:]]*$' "$log"; then
    echo "Android camera test did not report exactly one completed passing test. See $log" >&2
    return 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial) [[ $# -ge 2 ]] || fail "--serial needs a value"; SERIAL="$2"; shift 2 ;;
    --apk) [[ $# -ge 2 ]] || fail "--apk needs a path"; APK="$2"; shift 2 ;;
    --output-dir) [[ $# -ge 2 ]] || fail "--output-dir needs a path"; OUTPUT_DIR="$2"; shift 2 ;;
    --build-only) BUILD_ONLY=true; shift ;;
    --check-output) [[ $# -eq 2 ]] || fail "--check-output needs exactly one log path"; check_output "$2"; exit $? ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ "$BUILD_ONLY" == true || -n "$SERIAL" ]] || fail "Pass --serial to select the test device explicitly."
[[ "$BUILD_ONLY" == false || -z "$APK" ]] || fail "--build-only cannot install an APK."
[[ -z "$APK" || -f "$APK" ]] || fail "APK does not exist: $APK"
TEST_TIMEOUT="${TEST_TIMEOUT_SECONDS:-$TEST_TIMEOUT}"
[[ "$TEST_TIMEOUT" =~ ^[0-9]+$ && "$TEST_TIMEOUT" -ge 30 ]] || fail "TEST_TIMEOUT_SECONDS must be at least 30."

SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$SDK_DIR" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then SDK_DIR="$HOME/Library/Android/sdk";
  else SDK_DIR="$HOME/Android/Sdk"; fi
fi
PLATFORM_DIR="$SDK_DIR/platforms/${ANDROID_PLATFORM:-android-35}"
for file in android.jar uiautomator.jar optional/android.test.base.jar; do
  [[ -f "$PLATFORM_DIR/$file" ]] || fail "Missing SDK file: $PLATFORM_DIR/$file"
done
BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-}"
if [[ -z "$BUILD_TOOLS" ]]; then
  BUILD_TOOLS="$(find "$SDK_DIR/build-tools" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
fi
BUILD_TOOLS_DIR="$SDK_DIR/build-tools/$BUILD_TOOLS"
[[ -x "$BUILD_TOOLS_DIR/d8" ]] || fail "Missing Android d8 compiler: $BUILD_TOOLS_DIR/d8"

JDK_DIR="${JAVA_HOME:-}"
if [[ -z "$JDK_DIR" && -x '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac' ]]; then
  JDK_DIR='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
fi
if [[ -n "$JDK_DIR" ]]; then
  export JAVA_HOME="$JDK_DIR"
  export PATH="$JDK_DIR/bin:$PATH"
fi
command -v javac >/dev/null || fail "A JDK is required (set JAVA_HOME)."

OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_DIR/test-results/android-camera/$(date +%Y%m%d-%H%M%S)-$$}"
mkdir -p "$OUTPUT_DIR/classes"
OUTPUT_DIR="$(cd -- "$OUTPUT_DIR" && pwd)"
TEST_JAR="$OUTPUT_DIR/scanner-test.jar"
COMPILE_CP="$PLATFORM_DIR/android.jar:$PLATFORM_DIR/uiautomator.jar:$PLATFORM_DIR/optional/android.test.base.jar"
javac -source 8 -target 8 -Xlint:-options -classpath "$COMPILE_CP" \
  -d "$OUTPUT_DIR/classes" "$PROJECT_DIR/tests/android/ScannerStartupTest.java"
jar cf "$OUTPUT_DIR/scanner-classes.jar" -C "$OUTPUT_DIR/classes" .
"$BUILD_TOOLS_DIR/d8" --min-api 24 --lib "$PLATFORM_DIR/android.jar" \
  --classpath "$PLATFORM_DIR/uiautomator.jar" --classpath "$PLATFORM_DIR/optional/android.test.base.jar" \
  --output "$TEST_JAR" "$OUTPUT_DIR/scanner-classes.jar"
echo "Compiled Android camera test: $TEST_JAR"
[[ "$BUILD_ONLY" == false ]] || exit 0

ADB_BIN="$SDK_DIR/platform-tools/adb"
[[ -x "$ADB_BIN" ]] || fail "Missing adb: $ADB_BIN"
ADB=("$ADB_BIN" -s "$SERIAL")
[[ "$("${ADB[@]}" get-state)" == device ]] || fail "Selected device is not online: $SERIAL"
[[ "$("${ADB[@]}" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] || fail "Device has not finished booting. Wait and rerun."
"${ADB[@]}" shell test -r /system/framework/android.test.base.jar || fail "Device is missing android.test.base.jar."
"${ADB[@]}" shell test -r /system/framework/android.test.runner.jar || fail "Device is missing android.test.runner.jar."
"${ADB[@]}" shell command -v timeout >/dev/null || fail "Device needs the Android timeout command."

if [[ -n "$APK" ]]; then
  "$BUILD_TOOLS_DIR/aapt2" dump badging "$APK" > "$OUTPUT_DIR/apk-badging.txt"
  grep -q "package: name='dk.madsbuch.hjem'" "$OUTPUT_DIR/apk-badging.txt" || fail "The APK is not Hjem."
  if grep -q '^application-debuggable' "$OUTPUT_DIR/apk-badging.txt"; then fail "Use a release APK, not a debuggable APK."; fi
  "${ADB[@]}" install -r "$APK"
fi
"${ADB[@]}" shell pm path dk.madsbuch.hjem | grep -q '^package:' || fail "Hjem is not installed. Pass --apk release.apk."
"${ADB[@]}" shell dumpsys package dk.madsbuch.hjem > "$OUTPUT_DIR/package.txt"
if grep -Eq 'flags=\[[^]]*DEBUGGABLE' "$OUTPUT_DIR/package.txt"; then fail "Installed Hjem is debuggable. Install the release APK."; fi

REMOTE_DIR="/data/local/tmp/hjem-camera-$(date +%s)-$$"
"${ADB[@]}" shell mkdir -p "$REMOTE_DIR"
"${ADB[@]}" push "$TEST_JAR" "$REMOTE_DIR/scanner-test.jar" >/dev/null
"${ADB[@]}" shell wm dismiss-keyguard
"${ADB[@]}" logcat -c
RUN_LOG="$OUTPUT_DIR/instrumentation.log"
echo "Testing release Hjem on $SERIAL. Evidence: $OUTPUT_DIR"

# The wrapper consumes positional JARs, adds them to CLASSPATH alongside the
# Android runner, then passes `-e jars` to Java. The Java parser itself does not
# accept positional JARs. Explicitly add the base JAR for legacy JUnit classes.
RUN_STATUS=0
set +e
"${ADB[@]}" shell "timeout $TEST_TIMEOUT uiautomator runtest /system/framework/android.test.base.jar $REMOTE_DIR/scanner-test.jar -c ScannerStartupTest -e artifacts $REMOTE_DIR" 2>&1 | tee "$RUN_LOG"
RUN_STATUSES=("${PIPESTATUS[@]}")
set -e
RUN_STATUS="${RUN_STATUSES[0]}"
"${ADB[@]}" logcat -d -v threadtime > "$OUTPUT_DIR/logcat.txt" 2>&1 || true
"${ADB[@]}" pull "$REMOTE_DIR/." "$OUTPUT_DIR/" >/dev/null 2>&1 || true
"${ADB[@]}" shell rm -rf "$REMOTE_DIR" >/dev/null 2>&1 || true
[[ "${RUN_STATUSES[1]}" -eq 0 ]] || fail "Could not write the instrumentation log. Evidence: $OUTPUT_DIR"
[[ "$RUN_STATUS" -eq 0 ]] || fail "Android runner exited $RUN_STATUS (124 means timeout). Evidence: $OUTPUT_DIR"
check_output "$RUN_LOG" || exit 1
echo "Android camera regression passed. Evidence: $OUTPUT_DIR"
