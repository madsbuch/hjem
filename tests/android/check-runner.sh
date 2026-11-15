#!/usr/bin/env bash
# Offline regression for the runner's exit-zero instrumentation failure detection.
set -euo pipefail
TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../../scripts/test-android-camera.sh"
FIXTURES="$(mktemp -d "${TMPDIR:-/tmp}/hjem-camera-output.XXXXXX")"
trap 'rm -rf "$FIXTURES"' EXIT

printf 'INSTRUMENTATION_STATUS_CODE: 0\nOK (1 test)\nINSTRUMENTATION_STATUS_CODE: -1\n' > "$FIXTURES/pass"
bash "$RUNNER" --check-output "$FIXTURES/pass"

for fixture in failure error aborted incomplete zero multiple mixed exception; do
  case "$fixture" in
    failure) printf 'FAILURES!!!\nTests run: 1, Failures: 1, Errors: 0\n' ;;
    error) printf 'INSTRUMENTATION_STATUS: stack=java.lang.NoClassDefFoundError\nINSTRUMENTATION_STATUS_CODE: -1\n' ;;
    aborted) printf 'INSTRUMENTATION_FAILED: Process crashed\n' ;;
    incomplete) printf 'INSTRUMENTATION_STATUS_CODE: 1\n' ;;
    zero) printf 'OK (0 tests)\n' ;;
    multiple) printf 'OK (2 tests)\n' ;;
    mixed) printf 'OK (1 test)\nINSTRUMENTATION_STATUS_CODE: -2\n' ;;
    exception) printf 'OK (1 test)\nINSTRUMENTATION_STATUS: shortMsg=Failed resolution of: Landroid/test/RepetitiveTest;\nINSTRUMENTATION_STATUS_CODE: -1\n' ;;
  esac > "$FIXTURES/$fixture"
  if bash "$RUNNER" --check-output "$FIXTURES/$fixture" >/dev/null 2>&1; then
    echo "Runner incorrectly accepted $fixture output" >&2
    exit 1
  fi
done
echo 'Android runner output checks passed (1 success, 8 failure fixtures).'
