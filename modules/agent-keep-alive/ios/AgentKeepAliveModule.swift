import ExpoModulesCore
import UIKit

/**
 * iOS keep-alive: holds a single `beginBackgroundTask` assertion so the JS
 * thread driving the agent's SSE stream keeps running after the app is
 * backgrounded. Apple grants a finite window (historically ~30s); when it
 * elapses the expiration handler releases the assertion cleanly so the app is
 * never killed for overrunning.
 *
 * There is no `UIBackgroundModes` entry for this — a finite background task
 * assertion needs none. It is deliberately NOT a continuous background mode
 * (audio/location/etc.), which Apple would reject for this use.
 */
public class AgentKeepAliveModule: Module {
  private var taskId: UIBackgroundTaskIdentifier = .invalid

  public func definition() -> ModuleDefinition {
    Name("AgentKeepAlive")

    // Returns `true` for parity with Android, where a start can be refused.
    Function("start") { (_: String) -> Bool in
      self.begin()
      return true
    }

    Function("stop") {
      self.end()
    }

    OnDestroy {
      self.end()
    }
  }

  private func begin() {
    DispatchQueue.main.async {
      // Renew rather than stack: release any prior assertion first.
      if self.taskId != .invalid {
        UIApplication.shared.endBackgroundTask(self.taskId)
        self.taskId = .invalid
      }
      self.taskId = UIApplication.shared.beginBackgroundTask(withName: "TakumiAgentTurn") {
        // System reclaimed our time — release so we are not force-terminated.
        self.end()
      }
    }
  }

  private func end() {
    DispatchQueue.main.async {
      if self.taskId != .invalid {
        UIApplication.shared.endBackgroundTask(self.taskId)
        self.taskId = .invalid
      }
    }
  }
}
