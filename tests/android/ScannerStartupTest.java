import android.os.SystemClock;
import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.core.UiDevice;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiScrollable;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;

/** Exercises the installed release APK through Android's accessibility layer. */
public class ScannerStartupTest extends UiAutomatorTestCase {
  private static final String PACKAGE = "dk.madsbuch.hjem";
  private static final long CONTROL_TIMEOUT_MS = 45_000;
  private String phase = "startup";
  private String appPid;

  private void step(String detail) {
    System.out.println("CAMERA_TEST [" + SystemClock.uptimeMillis() + "] " + phase + ": " + detail);
    System.out.flush();
  }

  private void setPhase(String value) {
    phase = value;
    step("begin");
  }

  private String command(String... arguments) throws Exception {
    return command(true, arguments);
  }

  private String command(boolean report, String... arguments) throws Exception {
    if (report) step("command " + String.join(" ", arguments));
    Process process = new ProcessBuilder(arguments).redirectErrorStream(true).start();
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    InputStream input = process.getInputStream();
    byte[] buffer = new byte[4096];
    int length;
    while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
    input.close();
    int result = process.waitFor();
    String text = output.toString("UTF-8").trim();
    assertEquals("Command failed: " + arguments[0] + "\n" + text, 0, result);
    if (report) step("command completed: " + arguments[0]);
    return text;
  }

  // WebView controls may expose their accessible name as either text or description.
  private UiObject find(String label) {
    UiObject object = new UiObject(new UiSelector().packageName(PACKAGE).description(label));
    if (object.exists()) return object;
    return new UiObject(new UiSelector().packageName(PACKAGE).text(label));
  }

  private UiObject waitForControl(String label) throws Exception {
    step("waiting for control: " + label);
    long deadline = SystemClock.uptimeMillis() + CONTROL_TIMEOUT_MS;
    long reportAfter = SystemClock.uptimeMillis() + 5_000;
    int scrolls = 0;
    do {
      UiObject object = find(label);
      if (object.exists() && object.isEnabled()) {
        if (!object.getVisibleBounds().isEmpty()) return object;
        // WebView exposes offscreen DOM nodes with [0,0][0,0] bounds. A click
        // can report success at (0,0), so reveal the real control first.
        if (scrolls < 10 && (label.equals("Connect your home") || label.equals("Scan QR code"))) {
          UiScrollable content = new UiScrollable(new UiSelector().packageName(PACKAGE).scrollable(true));
          if (content.exists()) {
            step("scroll to offscreen control: " + label + " (" + (++scrolls) + "/10)");
            content.setAsVerticalList().scrollForward(30);
          }
        }
      }
      if (SystemClock.uptimeMillis() >= reportAfter) {
        step("still waiting for control: " + label);
        reportAfter = SystemClock.uptimeMillis() + 5_000;
      }
      sleep(150);
    } while (SystemClock.uptimeMillis() < deadline);
    fail("Missing, offscreen, or disabled control during " + phase + ": " + label);
    return null;
  }

  private void click(String label) throws Exception {
    UiObject object = waitForControl(label);
    step("click " + label);
    assertTrue("Could not click " + label + " during " + phase, object.click());
    step("click completed: " + label);
  }

  private void assertSameProcess() throws Exception {
    assertEquals("App left the foreground during " + phase,
        PACKAGE, getUiDevice().getCurrentPackageName());
    assertEquals("App crashed or restarted during " + phase,
        appPid, command(false, "pidof", PACKAGE));
  }

  private void assertScannerReady() throws Exception {
    waitForControl("Cancel scanning");
    waitForControl("Switch camera");
    step("waiting for camera readiness and checking process stability");
    long deadline = SystemClock.uptimeMillis() + CONTROL_TIMEOUT_MS;
    long readySince = 0;
    while (SystemClock.uptimeMillis() < deadline) {
      assertSameProcess();
      assertTrue("Scanner disappeared during " + phase, find("Cancel scanning").exists());
      assertFalse("Scanner showed a camera error during " + phase, find("Try again").exists());
      // A camera switch may begin after click() returns. Require three continuous
      // ready seconds, rather than accepting the outgoing preview for one frame.
      if (find("Opening camera…").exists()) readySince = 0;
      else if (readySince == 0) readySince = SystemClock.uptimeMillis();
      else if (SystemClock.uptimeMillis() - readySince >= 3_000) {
        step("camera ready; app process remained alive");
        capture(phase);
        return;
      }
      sleep(200);
    }
    fail("Camera never became stably ready during " + phase);
  }

  private void grantCameraPermission() throws Exception {
    step("waiting for Android camera permission dialog");
    UiObject permission = new UiObject(new UiSelector()
        .resourceIdMatches(".*:id/permission_allow_foreground_only_button"));
    if (!permission.waitForExists(10_000)) {
      permission = new UiObject(new UiSelector()
          .resourceIdMatches(".*:id/permission_allow_button"));
    }
    assertTrue("Expected a fresh Android camera permission dialog", permission.waitForExists(3_000));
    step("grant camera permission");
    assertTrue("Could not grant camera permission", permission.click());
    step("camera permission granted");
  }

  private void capture(String label) {
    try {
      String directory = getParams().getString("artifacts", "/data/local/tmp");
      UiDevice device = getUiDevice();
      step("capture screenshot: " + label);
      device.takeScreenshot(new File(directory, "camera-" + label + ".png"));
      // Legacy UiAutomator stores relative hierarchy names in /data/local/tmp.
      String relativeDirectory = directory.startsWith("/data/local/tmp/")
          ? directory.substring("/data/local/tmp/".length()) + "/" : "";
      step("capture hierarchy: " + label);
      device.dumpWindowHierarchy(relativeDirectory + "camera-" + label + ".xml");
      step("evidence captured: " + label);
    } catch (Exception error) {
      System.err.println("Could not collect UI evidence: " + error.getMessage());
    }
  }

  public void testPermissionThenCamera() throws Exception {
    try {
      step("configure accessibility polling and wake device");
      // Animated WebView spinners need not become completely idle to inspect controls.
      Configurator.getInstance().setWaitForIdleTimeout(500);
      getUiDevice().wakeUp();
      command("am", "force-stop", PACKAGE);
      command("pm", "revoke", PACKAGE, "android.permission.CAMERA");
      command("pm", "clear-permission-flags", PACKAGE, "android.permission.CAMERA", "user-set", "user-fixed");
      command("am", "start", "-W", "-n", PACKAGE + "/.MainActivity");
      click("Settings");
      click("Connect your home");
      waitForControl("Close connection settings");
      appPid = command("pidof", PACKAGE);
      assertFalse("App process was not running before opening the scanner", appPid.isEmpty());

      setPhase("permission-granted");
      click("Scan QR code");
      grantCameraPermission();
      assertScannerReady();

      setPhase("reopened");
      click("Cancel scanning");
      waitForControl("Scan QR code");
      assertFalse("Scanner remained open after cancel", find("Cancel scanning").exists());
      click("Scan QR code");
      assertScannerReady();

      setPhase("front-camera");
      click("Switch camera");
      assertScannerReady();
      setPhase("back-camera");
      click("Switch camera");
      assertScannerReady();

      setPhase("cancelled");
      click("Cancel scanning");
      waitForControl("Scan QR code");
      assertSameProcess();
      assertFalse("Scanner remained open after final cancel", find("Cancel scanning").exists());
      step("all camera regression checks passed");
    } finally {
      capture("final-" + phase);
    }
  }
}
