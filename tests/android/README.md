# Android camera regression

Use a disposable, unlocked Android emulator with an English UI and simulated
front and back cameras. The test restarts Hjem and revokes/regrants its camera
permission; it leaves app data intact. Run against the optimized release APK:

```sh
scripts/test-android-camera.sh --serial emulator-5554 --apk path/to/release.apk
```

This exercises permission grant, camera startup, cancellation, reopening, and
switching both cameras. It checks that the app stays in the same process and
collects screenshots, accessibility hierarchies, and logs under `test-results/`.
It does not verify QR recognition; browser tests cover decoding and token filling.
See `--help` for SDK/JDK requirements and output options.

The release optimizer previously stripped ML Kit's reflective registrar
constructors, causing a native crash immediately after camera permission.
GitHub runs `scripts/check-android-scanner.sh path/to/release.apk` on the packaged
DEX before signing/publishing. The defective APK fails this check, while the
ProGuard fix preserves the constructors without disabling optimization.

`bash tests/android/check-runner.sh` checks that failed or incomplete Android
instrumentation cannot be reported as a passing test merely because ADB exits 0.

## Home app return regression

Run on a disposable, unlocked emulator that has a stock launcher and a selected
default home app. This requires Python 3 and ADB, and deliberately rejects
physical-device serials:

```sh
python3 scripts/test-android-home.py --serial emulator-5554 --apk path/to/release.apk
```

The runner tests both cold-start orders: opening Hjem as an ordinary app before
pressing Android Home, and starting through Home before opening the app entry.
It backgrounds Hjem through Android Settings before each transition, then checks
ten repeated Home returns. Each scenario must retain one native activity and
the same process, with a visible WebView. Screenshots, accessibility hierarchies,
activity records, and logs are saved under `test-results/android-home/`.
Opening Hjem while another launcher is the default must preserve that choice;
Home must return to that launcher, and reopening Hjem must reuse its interface.

This catches the former shared launcher entry bug: even with `singleTask`, Android
could create separate STANDARD and HOME activities, leaving the second activity
without a WebView. The app icon now forwards through `LauncherActivity` to Hjem's
package-scoped implicit HOME intent before Tauri creates its interface. An explicit
`am start -n ... -c HOME` is insufficient to reproduce Android's real HOME task
classification; the test sends the actual Home key.

The test temporarily changes the emulator's default launcher and force-stops
Hjem. It restores the original default launcher in cleanup and leaves app data
intact. Do not run other UI automation on the same emulator concurrently.
