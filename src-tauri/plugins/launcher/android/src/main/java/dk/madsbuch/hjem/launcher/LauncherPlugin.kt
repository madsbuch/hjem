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
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.text.Collator

@InvokeArg
class LaunchAppArgs {
    var packageName: String = ""
}

@InvokeArg
class SaveDocumentArgs {
    var fileName: String = ""
    var text: String = ""
}

/** Larger than any configuration Hjem writes; protects against picking the wrong file. */
private const val MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

@TauriPlugin
class LauncherPlugin(private val activity: Activity) : Plugin(activity) {
    private var pendingDocument: String? = null

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

    /** Let the person choose where to save, e.g. Downloads or a cloud drive. */
    @Command
    fun saveDocument(invoke: Invoke) {
        val args = invoke.parseArgs(SaveDocumentArgs::class.java)
        pendingDocument = args.text
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/json")
            .putExtra(Intent.EXTRA_TITLE, args.fileName)
        try {
            startActivityForResult(invoke, intent, "documentSaved")
        } catch (_: ActivityNotFoundException) {
            pendingDocument = null
            invoke.reject("Android has no app for saving files on this device.")
        }
    }

    @ActivityCallback
    fun documentSaved(invoke: Invoke, result: ActivityResult) {
        val text = pendingDocument
        pendingDocument = null
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null || text == null) {
            invoke.resolve(JSObject().put("saved", false))
            return
        }
        Thread({
            try {
                val output = activity.contentResolver.openOutputStream(uri, "wt") ?: throw IOException()
                output.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                activity.runOnUiThread { invoke.resolve(JSObject().put("saved", true)) }
            } catch (_: Exception) {
                activity.runOnUiThread { invoke.reject("The file could not be saved there. Choose another location.") }
            }
        }).start()
    }

    @Command
    fun openDocument(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "application/octet-stream"))
        try {
            startActivityForResult(invoke, intent, "documentOpened")
        } catch (_: ActivityNotFoundException) {
            invoke.reject("Android has no app for opening files on this device.")
        }
    }

    @ActivityCallback
    fun documentOpened(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolve(JSObject().put("cancelled", true))
            return
        }
        Thread({
            try {
                val input = activity.contentResolver.openInputStream(uri) ?: throw IOException()
                val bytes = input.use { stream ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = stream.read(buffer)
                        if (count < 0) break
                        if (output.size() + count > MAX_DOCUMENT_BYTES) throw IllegalStateException()
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
                val text = String(bytes, Charsets.UTF_8)
                activity.runOnUiThread { invoke.resolve(JSObject().put("text", text)) }
            } catch (_: IllegalStateException) {
                activity.runOnUiThread { invoke.reject("This file is too large to be a Hjem configuration.") }
            } catch (_: Exception) {
                activity.runOnUiThread { invoke.reject("The file could not be opened. Choose another file.") }
            }
        }).start()
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
