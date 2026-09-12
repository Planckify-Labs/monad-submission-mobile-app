import ExpoModulesCore

/**
 * iOS cannot send an app to the background programmatically without a
 * private API, so this always reports `false`; the JS side then relies
 * on the dApp's redirect URL or the system back breadcrumb.
 */
public class AppMinimizerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppMinimizer")

    Function("moveTaskToBack") { () -> Bool in
      return false
    }
  }
}
