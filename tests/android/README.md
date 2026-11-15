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
