package com.openplod.vault

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.io.File

/**
 * OpenPlod's own recorder. A microphone foreground service keeps recording while the screen is off
 * or the phone is locked; the web view's MediaRecorder loses the microphone then and records silence.
 * The take is an AAC .m4a in app storage until the person saves it to the phone library or discards it.
 */
class RecordingService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stop(this); return START_NOT_STICKY }
            ACTION_PAUSE -> { pause(this); return START_NOT_STICKY }
            ACTION_RESUME -> { resume(this); return START_NOT_STICKY }
        }
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
        ServiceCompat.startForeground(this, NOTIFICATION, notification(this),
            if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
        synchronized(lock) {
            if (recorder == null) try { begin(this) } catch (error: Exception) {
                failure = error.message ?: "The microphone could not be started."
                state = "idle"; release()
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    /** Android stopping the service ends the take cleanly, so the file stays playable. */
    override fun onDestroy() { synchronized(lock) { if (recorder != null) finish(this) }; super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "recorder"
        private const val NOTIFICATION = 4300
        private const val ACTION_STOP = "com.openplod.vault.record.STOP"
        private const val ACTION_PAUSE = "com.openplod.vault.record.PAUSE"
        private const val ACTION_RESUME = "com.openplod.vault.record.RESUME"
        private val lock = Any()
        private var recorder: MediaRecorder? = null
        private var wakeLock: PowerManager.WakeLock? = null
        @Volatile private var state = "idle"
        @Volatile private var failure: String? = null
        private var take: String? = null
        private var startedAt = 0L
        private var accumulatedMs = 0L
        private var activeSince = 0L

        private fun takes(context: Context) = File(context.filesDir, "native-recordings").apply { mkdirs() }
        private fun preferences(context: Context) = context.getSharedPreferences("recorder", Context.MODE_PRIVATE)
        fun takeFile(context: Context, take: String): File {
            require(take.matches(Regex("[0-9a-f-]{36}"))) { "Invalid recording." }
            return File(takes(context), "$take.m4a")
        }

        /** Starts the service; it starts the microphone once it is in the foreground. */
        fun start(context: Context) {
            synchronized(lock) {
                check(state == "idle" && recorder == null) { "A recording is already running." }
                check(preferences(context).getString("take", null) == null) { "Save or discard the last recording first." }
                state = "starting"; failure = null
            }
            val intent = Intent(context, RecordingService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        private fun begin(context: Context) {
            val id = java.util.UUID.randomUUID().toString()
            val file = takeFile(context, id)
            val media = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
            try {
                media.setAudioSource(MediaRecorder.AudioSource.MIC)
                media.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                media.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                media.setAudioChannels(1)
                media.setAudioSamplingRate(44100)
                // 48 kbps mono keeps speech clear and about 70 minutes under OpenAI's 25 MB upload limit.
                media.setAudioEncodingBitRate(48000)
                media.setOutputFile(file.absolutePath)
                media.prepare()
                media.start()
            } catch (error: Exception) { media.release(); file.delete(); throw error }
            recorder = media
            wakeLock = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OpenPlod:recording").apply { acquire(12 * 60 * 60 * 1000L) }
            take = id; startedAt = System.currentTimeMillis(); accumulatedMs = 0; activeSince = SystemClock.elapsedRealtime()
            state = "recording"
        }

        fun pause(context: Context) = synchronized(lock) {
            val media = recorder ?: return@synchronized
            if (state != "recording" || Build.VERSION.SDK_INT < 24) return@synchronized
            media.pause()
            accumulatedMs += SystemClock.elapsedRealtime() - activeSince
            state = "paused"; update(context)
        }

        fun resume(context: Context) = synchronized(lock) {
            val media = recorder ?: return@synchronized
            if (state != "paused" || Build.VERSION.SDK_INT < 24) return@synchronized
            media.resume()
            activeSince = SystemClock.elapsedRealtime()
            state = "recording"; update(context)
        }

        /** Ends the take; it waits in app storage for "Save" or "Discard", even across a restart. */
        fun stop(context: Context) {
            synchronized(lock) { if (recorder != null) finish(context) }
            context.stopService(Intent(context, RecordingService::class.java))
        }

        private fun finish(context: Context) {
            val media = recorder ?: return
            if (state == "recording") accumulatedMs += SystemClock.elapsedRealtime() - activeSince
            val stopped = runCatching { media.stop() }.isSuccess
            release()
            val id = take
            val file = id?.let { takeFile(context, it) }
            if (!stopped || file == null || file.length() == 0L) {
                file?.delete(); failure = "The recording was too short or the microphone stopped."
                take = null; state = "idle"; return
            }
            preferences(context).edit().putString("take", id).putLong("durationMs", accumulatedMs).putLong("startedAt", startedAt).apply()
            take = null; state = "idle"
        }

        private fun release() {
            runCatching { recorder?.release() }; recorder = null
            wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
        }

        /** Saves the finished take into the phone library (and Recordings/OpenPlod); returns its id. */
        fun keep(context: Context, id: String, name: String, send: Boolean): Long {
            val file = takeFile(context, id)
            check(file.exists() && file.length() > 0) { "This recording is no longer on the phone." }
            val saved = PhoneRecordings.keepRecording(context, file, name, send)
            file.delete(); forget(context, id)
            return saved
        }

        fun discard(context: Context, id: String) { takeFile(context, id).delete(); forget(context, id) }

        private fun forget(context: Context, id: String) {
            val preferences = preferences(context)
            if (preferences.getString("take", null) == id) preferences.edit().clear().apply()
        }

        fun read(context: Context, id: String, offset: Long, length: Int): ByteArray {
            val file = takeFile(context, id)
            val size = minOf(length.coerceIn(1, 1 shl 20).toLong(), file.length() - offset).coerceAtLeast(0).toInt()
            return java.io.RandomAccessFile(file, "r").use { input -> ByteArray(size).also { input.seek(offset); input.readFully(it) } }
        }

        fun status(context: Context): JSONObject = synchronized(lock) {
            val value = JSONObject().put("state", state).put("error", failure ?: JSONObject.NULL)
            val media = recorder
            if (media != null) {
                val elapsed = accumulatedMs + if (state == "recording") SystemClock.elapsedRealtime() - activeSince else 0
                val level = if (state == "recording") runCatching { media.maxAmplitude / 32767.0 }.getOrDefault(0.0) else 0.0
                return@synchronized value.put("elapsedMs", elapsed).put("level", level).put("startedAt", startedAt)
            }
            val preferences = preferences(context)
            val finished = preferences.getString("take", null)
            if (finished != null) {
                val file = takeFile(context, finished)
                if (!file.exists()) { preferences.edit().clear().apply(); return@synchronized value }
                value.put("state", "stopped").put("take", finished).put("size", file.length())
                    .put("elapsedMs", preferences.getLong("durationMs", 0)).put("startedAt", preferences.getLong("startedAt", 0))
            }
            value
        }

        private fun update(context: Context) {
            runCatching { context.getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(context)) }
        }

        private fun action(context: Context, action: String, code: Int) = PendingIntent.getService(context, code,
            Intent(context, RecordingService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        private fun notification(context: Context) = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(if (state == "paused") "OpenPlod recording paused" else "OpenPlod is recording")
            .setContentText("Keeps recording with the screen off. Tap to open.")
            .setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setUsesChronometer(state == "recording")
            .setWhen(System.currentTimeMillis() - (accumulatedMs + if (state == "recording") SystemClock.elapsedRealtime() - activeSince else 0))
            .setContentIntent(context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) })
            .apply {
                if (Build.VERSION.SDK_INT >= 24) {
                    if (state == "paused") addAction(0, "Resume", action(context, ACTION_RESUME, 2))
                    else addAction(0, "Pause", action(context, ACTION_PAUSE, 1))
                }
            }
            .addAction(0, "Stop", action(context, ACTION_STOP, 3))
            .build()
    }
}
