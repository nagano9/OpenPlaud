package com.openplod.vault

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.util.concurrent.Executors

/** Runs phone transcriptions one after another, so they finish with the screen off. */
class TranscriptionService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "Transcription", NotificationManager.IMPORTANCE_LOW))
        ServiceCompat.startForeground(this, NOTIFICATION, notification(this, "Preparing..."),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
        val id = intent?.getLongExtra(EXTRA_ID, -1L) ?: -1L
        if (id >= 0 && queued.add(id)) {
            PhoneTranscriber.jobs[id] = JSONObject().put("state", "queued")
            worker.execute { run(id) }
        }
        return START_NOT_STICKY
    }

    private fun run(id: Long) {
        val manager = getSystemService(NotificationManager::class.java)
        val progress = Thread {
            while (!Thread.currentThread().isInterrupted) {
                val job = PhoneTranscriber.jobs[id]
                val text = if (job?.optString("state") == "running") "Transcribing ${job.optInt("done") + 1} of ${job.optInt("total")}..." else "Preparing..."
                runCatching { manager.notify(NOTIFICATION, notification(this, text)) }
                try { Thread.sleep(2000) } catch (_: InterruptedException) { break }
            }
        }.apply { start() }
        try { PhoneTranscriber.transcribe(this, id) }
        catch (error: Exception) { android.util.Log.w("OpenPlodTranscribe", "recording $id: ${error.message}") }
        finally {
            progress.interrupt()
            queued.remove(id)
            if (queued.isEmpty()) {
                val failed = PhoneTranscriber.jobs[id]?.optString("state") == "failed"
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                // A short note that stays, so the result is visible after the phone was locked.
                runCatching { manager.notify(DONE, notification(this, if (failed) "Transcription failed. Open OpenPlod to see why." else "Transcript ready.", ongoing = false)) }
                stopSelf()
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "transcription"
        private const val NOTIFICATION = 4400
        private const val DONE = 4401
        private const val EXTRA_ID = "id"
        private val worker = Executors.newSingleThreadExecutor()
        private val queued = java.util.Collections.synchronizedSet(mutableSetOf<Long>())

        fun start(context: Context, id: Long) {
            val intent = Intent(context, TranscriptionService::class.java).putExtra(EXTRA_ID, id)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        private fun notification(context: Context, text: String, ongoing: Boolean = true) = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_edit).setContentTitle("OpenPlod transcription").setContentText(text)
            .setOngoing(ongoing).setAutoCancel(!ongoing).setOnlyAlertOnce(true)
            .setContentIntent(context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                android.app.PendingIntent.getActivity(context, 0, it, android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT) })
            .build()
    }
}
