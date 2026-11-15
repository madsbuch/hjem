package dk.madsbuch.hjem.launcher

import android.app.Activity
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.text.Collator

@InvokeArg
class LaunchAppArgs {
    var packageName: String = ""
}

@TauriPlugin
class LauncherPlugin(private val activity: Activity) : Plugin(activity) {
    private fun launcherIntent() = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)

    override fun onNewIntent(intent: Intent) {
        if (intent.action == Intent.ACTION_MAIN && intent.hasCategory(Intent.CATEGORY_HOME)) {
            trigger("homeRequested", JSObject())
        }
    }

    @Suppress("DEPRECATION")
    private fun launchableApps(packageName: String? = null): List<ResolveInfo> {
        val intent = launcherIntent().apply { if (packageName != null) setPackage(packageName) }
        return activity.packageManager.queryIntentActivities(intent, 0).filter {
            it.activityInfo != null && it.activityInfo.exported && it.activityInfo.enabled &&
                it.activityInfo.applicationInfo.enabled && it.activityInfo.packageName != activity.packageName
        }
    }

    private fun appIcon(info: ResolveInfo): String? = try {
        val drawable = info.loadIcon(activity.packageManager)
        val bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
        try {
            drawable.setBounds(0, 0, 96, 96)
            drawable.draw(Canvas(bitmap))
            val bytes = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
            "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
        } finally {
            bitmap.recycle()
        }
    } catch (_: Exception) {
        null // The UI can display its letter fallback if one app's icon cannot load.
    }

    @Command
    fun listApps(invoke: Invoke) {
        // Icon decoding and package discovery should not block touches on the home screen.
        Thread({
            try {
                val pm = activity.packageManager
                val collator = Collator.getInstance()
                val apps = launchableApps().distinctBy { it.activityInfo.packageName }.map { info ->
                    mutableMapOf<String, String>(
                        "packageName" to info.activityInfo.packageName,
                        "name" to info.loadLabel(pm).toString().ifBlank { info.activityInfo.packageName }
                    ).apply { appIcon(info)?.let { put("icon", it) } }
                }.sortedWith { left, right -> collator.compare(left["name"], right["name"]) }
                activity.runOnUiThread { invoke.resolveObject(apps) }
            } catch (_: Exception) {
                activity.runOnUiThread { invoke.reject("Installed apps could not be loaded. Please try again.") }
            }
        }, "hjem-app-discovery").start()
    }

    @Command
    fun launchApp(invoke: Invoke) {
        val args = invoke.parseArgs(LaunchAppArgs::class.java)
        activity.runOnUiThread {
            try {
                if (args.packageName.isBlank() || args.packageName == activity.packageName) {
                    invoke.reject("Choose an installed app to open.")
                    return@runOnUiThread
                }
                val target = launchableApps(args.packageName).firstOrNull()?.activityInfo
                if (target == null) {
                    invoke.reject("This app is no longer available. Refresh your apps and try again.")
                    return@runOnUiThread
                }
                val intent = launcherIntent().apply {
                    component = ComponentName(target.packageName, target.name)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
                }
                activity.startActivity(intent)
                invoke.resolve()
            } catch (_: Exception) {
                invoke.reject("Android could not open this app. It may be disabled or restricted.")
            }
        }
    }

    private fun openPackageScreen(invoke: Invoke, action: String, failureMessage: String) {
        val args = try {
            invoke.parseArgs(LaunchAppArgs::class.java)
        } catch (_: Exception) {
            invoke.reject("Choose an installed app to manage.")
            return
        }
        activity.runOnUiThread {
            try {
                if (args.packageName.isBlank() || args.packageName == activity.packageName) {
                    invoke.reject("Choose an installed app to manage.")
                    return@runOnUiThread
                }
                // Re-query the current profile. Stale UI data must not target an
                // uninstalled, disabled, hidden, or non-launchable package.
                val target = launchableApps(args.packageName).firstOrNull()?.activityInfo
                if (target == null || target.packageName != args.packageName) {
                    invoke.reject("This app is no longer available. Refresh your apps and try again.")
                    return@runOnUiThread
                }
                val packageUri = Uri.fromParts("package", target.packageName, null)
                activity.startActivity(Intent(action, packageUri))
                // Android owns the confirmation and result. Opening this screen
                // does not imply that an uninstall has been accepted/completed.
                invoke.resolve()
            } catch (_: Exception) {
                invoke.reject(failureMessage)
            }
        }
    }

    @Command
    fun uninstallApp(invoke: Invoke) {
        openPackageScreen(
            invoke,
            Intent.ACTION_DELETE,
            "Android could not open the uninstall confirmation. This app may be protected or restricted."
        )
    }

    @Command
    fun openAppInfo(invoke: Invoke) {
        openPackageScreen(
            invoke,
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            "Android could not open App info for this app."
        )
    }

    @Command
    @Suppress("DEPRECATION")
    fun getStatus(invoke: Invoke) {
        try {
            val isDefault = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val roles = activity.getSystemService(RoleManager::class.java)
                roles != null && roles.isRoleAvailable(RoleManager.ROLE_HOME) && roles.isRoleHeld(RoleManager.ROLE_HOME)
            } else {
                val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                activity.packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)
                    ?.activityInfo?.packageName == activity.packageName
            }
            invoke.resolve(JSObject().put("supported", true).put("isDefaultHome", isDefault))
        } catch (_: Exception) {
            invoke.reject("Android's home app status could not be read.")
        }
    }

    @Command
    fun openHomeSettings(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                try {
                    activity.startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
                } catch (_: ActivityNotFoundException) {
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
                }
                invoke.resolve()
            } catch (_: Exception) {
                invoke.reject("Open Android Settings → Apps → Default apps → Home app to choose Hjem.")
            }
        }
    }
}
