package expo.modules.agentkeepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * A short-lived `dataSync` foreground service that keeps the app process — and
 * with it the JS thread driving the agent's SSE stream — alive while a Takumi
 * Agent turn finishes in the background. Started/stopped from JS via
 * [AgentKeepAliveModule]; it does no work itself, it only holds the OS alive.
 */
class AgentForegroundService : Service() {
  companion object {
    const val EXTRA_REASON = "reason"
    private const val CHANNEL_ID = "takumi_agent_tasks"
    private const val NOTIFICATION_ID = 4827
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val reason = intent?.getStringExtra(EXTRA_REASON) ?: "Finishing your request…"
    ensureChannel()
    val notification = buildNotification(reason)

    // `startForeground` itself can throw: ForegroundServiceStartNotAllowedException
    // (API 31+, started from the background) or SecurityException (API 34+, the
    // service type's permission is missing). An uncaught throw here takes the
    // whole process down, so give up the assertion instead of the app.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      stopSelf()
      return START_NOT_STICKY
    }

    // If the OS kills us under memory pressure, don't resurrect: the JS turn
    // that asked for the assertion is already gone, so there is nothing to keep
    // alive on restart.
    return START_NOT_STICKY
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Agent tasks",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shown while Takumi Agent finishes a task in the background."
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(reason: String): Notification {
    // Reuse the app's launcher icon so we don't have to ship a dedicated
    // notification asset. It renders as a white silhouette in the status bar,
    // which is the expected look for a small icon.
    val smallIcon = applicationInfo.icon
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Takumi Agent")
      .setContentText(reason)
      .setSmallIcon(smallIcon)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }
}
