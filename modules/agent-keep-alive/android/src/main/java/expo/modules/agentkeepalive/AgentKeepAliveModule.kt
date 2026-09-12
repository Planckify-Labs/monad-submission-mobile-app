package expo.modules.agentkeepalive

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Bridges the JS `start(reason)` / `stop()` calls to [AgentForegroundService].
 *
 * `start` MUST be invoked while the app is still in the foreground: Android 12+
 * (API 31) throws `ForegroundServiceStartNotAllowedException` when a foreground
 * service is launched from the background. The JS controller
 * (`hooks/useAgentBackgroundKeepAlive.ts`) honours this by claiming the service
 * as soon as a turn starts streaming, not on the background transition.
 */
class AgentKeepAliveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AgentKeepAlive")

    // Returns whether the service start was accepted. Android 12+ throws
    // `ForegroundServiceStartNotAllowedException` for a start from the
    // background; a turn that began there simply runs unprotected instead of
    // surfacing an error to JS.
    Function("start") { reason: String ->
      val context = appContext.reactContext ?: return@Function false
      try {
        val intent = Intent(context, AgentForegroundService::class.java).apply {
          putExtra(AgentForegroundService.EXTRA_REASON, reason)
        }
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (e: Exception) {
        false
      }
    }

    // Every exit returns a Boolean: Kotlin 2 (K2) infers the lambda's type
    // from all of them, and a bare `return@Function` (Unit) next to the
    // Boolean from `stopService` fails with "expected 'Any?', actual 'Unit'".
    Function("stop") {
      val context = appContext.reactContext ?: return@Function false
      try {
        context.stopService(Intent(context, AgentForegroundService::class.java))
      } catch (e: Exception) {
        // Nothing to release; the service was never started or is already gone.
        false
      }
    }
  }
}
