package dk.madsbuch.hjem

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Makes the app icon and Android Home enter the same HOME-type task. */
class LauncherActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Keep this implicit: an explicitly targeted HOME intent can be classified
    // as a normal app launch. Restrict resolution to Hjem without changing the
    // user's default launcher or opening another app's home screen.
    startActivity(Intent(Intent.ACTION_MAIN).apply {
      addCategory(Intent.CATEGORY_HOME)
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
    finish()
  }
}
