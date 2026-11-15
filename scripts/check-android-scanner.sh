#!/usr/bin/env bash
# Check the packaged DEX, not source rules: R8 must retain ML Kit's reflective
# registrar constructors or the scanner crashes when the camera starts.
set -euo pipefail

fail() { echo "Android scanner check failed: $*" >&2; exit 1; }
if [[ $# -ne 1 || "$1" == --help || "$1" == -h ]]; then
  echo "Usage: scripts/check-android-scanner.sh path/to/release.apk"
  echo "Requires a JDK, Python 3 and Android SDK apkanalyzer."
  echo "Overrides: APKANALYZER, ANDROID_HOME / ANDROID_SDK_ROOT, JAVA_HOME."
  [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]] && exit 0
  exit 2
fi
apk="$1"
[[ -f "$apk" ]] || fail "APK does not exist: $apk"

sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk_dir" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then sdk_dir="$HOME/Library/Android/sdk";
  else sdk_dir="$HOME/Android/Sdk"; fi
fi
analyzer="${APKANALYZER:-$sdk_dir/cmdline-tools/latest/bin/apkanalyzer}"
if [[ ! -x "$analyzer" && -z "${APKANALYZER:-}" ]]; then
  analyzer="$(command -v apkanalyzer || true)"
fi
[[ -x "$analyzer" ]] || fail "Install Android SDK command-line tools or set APKANALYZER."
command -v python3 >/dev/null || fail "Python 3 is required to read the APK manifest."
if [[ -z "${JAVA_HOME:-}" && -x '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java' ]]; then
  export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/hjem-scanner-check.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
"$analyzer" manifest print "$apk" > "$work_dir/manifest.xml" 2> "$work_dir/analyzer.log" || {
  cat "$work_dir/analyzer.log" >&2
  fail "Could not inspect APK manifest."
}
python3 - "$work_dir/manifest.xml" > "$work_dir/registrars" <<'PY'
import sys
import xml.etree.ElementTree as ET

android = '{http://schemas.android.com/apk/res/android}'
prefix = 'com.google.firebase.components:'
registrars = {
    item.get(android + 'name', '')[len(prefix):]
    for item in ET.parse(sys.argv[1]).iter('meta-data')
    if item.get(android + 'name', '').startswith(prefix + 'com.google.mlkit.')
    and item.get(android + 'value') == 'com.google.firebase.components.ComponentRegistrar'
}
required = {
    'com.google.mlkit.vision.barcode.internal.BarcodeRegistrar',
    'com.google.mlkit.vision.common.internal.VisionCommonRegistrar',
    'com.google.mlkit.common.internal.CommonComponentRegistrar',
}
missing = required - registrars
if missing:
    sys.exit('Android scanner check failed: missing manifest registrars: ' + ', '.join(sorted(missing)))
print('\n'.join(sorted(registrars)))
PY

failed=0
count=0
while IFS= read -r registrar; do
  count=$((count + 1))
  if ! "$analyzer" dex code --class "$registrar" "$apk" > "$work_dir/class.smali" 2> "$work_dir/analyzer.log"; then
    cat "$work_dir/analyzer.log" >&2
    echo "Missing DEX class: $registrar" >&2
    failed=1
  elif ! grep -Eq '^\.method[[:space:]]+public[[:space:]]+([^[:space:]]+[[:space:]]+)*<init>\(\)V[[:space:]]*$' "$work_dir/class.smali"; then
    echo "Missing public no-arg constructor: $registrar" >&2
    failed=1
  fi
done < "$work_dir/registrars"

[[ "$failed" -eq 0 ]] || fail "R8 stripped scanner registrars; check the ComponentRegistrar ProGuard keep rule."
echo "Android scanner check passed: $count ML Kit registrar constructors retained."
