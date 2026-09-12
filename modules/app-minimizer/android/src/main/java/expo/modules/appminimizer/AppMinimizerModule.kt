package expo.modules.appminimizer

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * `moveTaskToBack(true)`: the whole task goes behind whatever launched it
 * (the browser for a deep-linked WalletConnect request), the activity
 * and the React instance stay alive. See modules/app-minimizer/index.ts.
 */
class AppMinimizerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppMinimizer")

    Function("moveTaskToBack") {
      val activity = appContext.currentActivity ?: return@Function false
      activity.moveTaskToBack(true)
    }
  }
}
