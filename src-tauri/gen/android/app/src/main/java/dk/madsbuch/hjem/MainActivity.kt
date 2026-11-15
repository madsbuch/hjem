package dk.madsbuch.hjem

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var insetHost: View? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    fitContentInsideSystemBars()
  }

  override fun onContentChanged() {
    super.onContentChanged()
    // Wry installs its WebView asynchronously through setContentView. Keep the
    // listener on its parent so the actual viewport, including fixed web UI,
    // stays inside Android's status/navigation bars and landscape cutouts.
    fitContentInsideSystemBars()
  }

  private fun fitContentInsideSystemBars() {
    val content = findViewById<View>(android.R.id.content) ?: return
    if (insetHost !== content) {
      insetHost = content
      val left = content.paddingLeft
      val top = content.paddingTop
      val right = content.paddingRight
      val bottom = content.paddingBottom
      ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
        // Union takes the largest inset per edge: navigation and keyboard
        // heights must not be added together. adjustResize supports older APIs.
        val safe = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or
            WindowInsetsCompat.Type.displayCutout() or
            WindowInsetsCompat.Type.ime()
        )
        view.setPadding(left + safe.left, top + safe.top, right + safe.right, bottom + safe.bottom)
        // The native parent owns these insets. Do not pass them to WebView's
        // CSS safe-area handling as well, which would produce double padding.
        WindowInsetsCompat.CONSUMED
      }
    }
    ViewCompat.requestApplyInsets(content)
  }
}
