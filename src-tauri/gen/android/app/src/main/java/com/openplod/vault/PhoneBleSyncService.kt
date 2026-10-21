package com.openplod.vault

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Base64
import androidx.core.app.NotificationCompat

/** Keeps the Bluetooth sync server running while "Sync over Bluetooth" is on. */
class PhoneBleSyncService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val preferences = preferences(this)
        val clientId = preferences.getString("clientId", null)
        val key = preferences.getString("key", null)?.let { Base64.decode(it, Base64.NO_WRAP) }
        if (!preferences.getBoolean("enabled", false) || clientId == null || key == null) { stopSelf(); return START_NOT_STICKY }
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("phone-ble", "Bluetooth sync", NotificationManager.IMPORTANCE_LOW))
        startForeground(4200, NotificationCompat.Builder(this, "phone-ble").setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("OpenPlod Bluetooth sync").setContentText("Your desktop can copy voice recordings from this phone. Nothing is deleted.").setOngoing(true).build())
        if (running == null) {
            try { running = PhoneBleServer(this, clientId, key).also { it.start() }; failure = null }
            catch (error: Exception) { failure = error.message ?: "Bluetooth sync could not start"; stopSelf() }
        }
        return START_STICKY
    }

    override fun onDestroy() { running?.stop(); running = null; super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        @Volatile private var running: PhoneBleServer? = null
        @Volatile private var failure: String? = null
        /** What the phone side is doing now, for the app's Bluetooth sync card. */
        val status: String get() = running?.lastEvent ?: failure ?: "Off"
        val active: Boolean get() = running != null
        fun preferences(context: Context) = context.getSharedPreferences("phone-ble", Context.MODE_PRIVATE)
    }
}
