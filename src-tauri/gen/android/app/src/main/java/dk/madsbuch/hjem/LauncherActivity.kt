package dk.madsbuch.hjem

import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle

/**
 * Opens Hjem from its app icon in the way that suits the device.
 *
 * Where Hjem is the home screen, the icon and Android Home enter the same
 * HOME-type task, which Android keeps out of the app switcher. Where it is
 * an ordinary app, it opens as an ordinary task, so it appears in the app
 * switcher like any other app.
 */
class LauncherActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    startActivity(if (isDefaultHome()) {
      // Keep this implicit: an explicitly targeted HOME intent can be classified
      // as a normal app launch. Restrict resolution to Hjem without changing the
      // user's default launcher or opening another app's home screen.
      Intent(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_HOME)
        setPackage(packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
    } else {
      // Explicit and without the HOME category, so Android treats it as a normal app.
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
    finish()
  }

  @Suppress("DEPRECATION")
  private fun isDefaultHome(): Boolean = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val roles = getSystemService(RoleManager::class.java)
      roles != null && roles.isRoleAvailable(RoleManager.ROLE_HOME) && roles.isRoleHeld(RoleManager.ROLE_HOME)
    } else {
      val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
      packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName == packageName
    }
  } catch (_: Exception) {
    // If Android will not say, open as an ordinary app; that is always reachable.
    false
  }
}
