package com.openplod.vault

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import app.tauri.PermissionState
import app.tauri.annotation.*
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.Executors

@TauriPlugin(permissions = [
    Permission(alias = "bluetooth", strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT]),
    Permission(alias = "location", strings = [Manifest.permission.ACCESS_FINE_LOCATION]),
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
    Permission(alias = "bluetoothServer", strings = [Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT]),
    Permission(alias = "audioRecordings", strings = [Manifest.permission.READ_MEDIA_AUDIO]),
    Permission(alias = "storage", strings = [Manifest.permission.READ_EXTERNAL_STORAGE]),
    Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
])
class PlaudPlugin(private val activity: Activity) : Plugin(activity) {
    private val controller by lazy { DirectPlaudController.get(activity) }
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val vault = PlaudVaultClient()
    private var player: MediaPlayer? = null
    private var playingId: String? = null
    private fun value() = JSObject(controller.snapshot().put("playingId", playingId ?: org.json.JSONObject.NULL).toString())
    private fun guarded(invoke: Invoke, action: () -> Unit = {}) { try { action(); invoke.resolve(value()) } catch (e: Exception) { invoke.reject(e.message ?: "Plaud operation failed.") } }
    @Command fun snapshot(invoke: Invoke) = guarded(invoke)
    @Command fun initialize(invoke: Invoke) = guarded(invoke) { controller.identity.read() }
    @Command fun permissions(invoke: Invoke) {
        requestPermissionForAliases(if (Build.VERSION.SDK_INT >= 33) arrayOf("bluetooth", "notifications") else if (Build.VERSION.SDK_INT >= 31) arrayOf("bluetooth") else arrayOf("location"), invoke, "permissionResult")
    }
    @PermissionCallback fun permissionResult(invoke: Invoke) = guarded(invoke)
    private fun access() {
        if (Build.VERSION.SDK_INT < 31) check(getPermissionState("location") == PermissionState.GRANTED) { "Allow location access for Bluetooth scanning on this Android version." }
        if (Build.VERSION.SDK_INT >= 31) check(getPermissionState("bluetooth") == PermissionState.GRANTED) { "Allow Bluetooth access." }
    }
    @Command fun scan(invoke: Invoke) = guarded(invoke) { access(); controller.run() }
    @Command fun connect(invoke: Invoke) = scan(invoke)
    @Command fun refresh(invoke: Invoke) = scan(invoke)
    @Command fun download(invoke: Invoke) = guarded(invoke) { access(); controller.run(setOf(invoke.getArgs().getString("sessionId").toLong())) }
    @Command fun cancel(invoke: Invoke) = guarded(invoke) { controller.cancel() }
    @Command fun disconnect(invoke: Invoke) = cancel(invoke)
    @Command fun autoImport(invoke: Invoke) = guarded(invoke) {
        val enabled = invoke.getArgs().getBoolean("enabled")
        if (enabled) { access(); controller.identity.read() }
        controller.preferences.edit().putBoolean("autoImport", enabled).apply()
        val intent = Intent(activity, PlaudImportService::class.java)
        if (!enabled) { activity.stopService(intent); controller.cancel() }
        else if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent) else activity.startService(intent)
    }
    @Command fun requestAuthorization(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try {
                vault.configure(args.getString("origin"), args.getString("pairingToken"))
                val result = vault.requestAuthorization(controller.identity.enrollmentKey(), Build.MODEL)
                controller.preferences.edit().putString("enrollmentId", result.getString("id")).apply()
                main.post { invoke.resolve(JSObject(result.toString())) }
            } catch (e: Exception) { main.post { invoke.reject(e.message ?: "Could not request authorization.") } }
        }
    }
    @Command fun finishAuthorization(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try {
                vault.configure(args.getString("origin"), args.getString("pairingToken"))
                val id = controller.preferences.getString("enrollmentId", null) ?: error("Request authorization first.")
                val result = vault.authorization(id)
                check(result.getString("state") == "approved") { "Approve this phone in OpenPlod on your Mac." }
                controller.identity.accept(result.getJSONObject("envelope"), id)
                vault.acknowledgeAuthorization(id)
                controller.preferences.edit().remove("enrollmentId").apply()
                main.post { guarded(invoke) }
            } catch (e: Exception) { main.post { invoke.reject(e.message ?: "Authorization failed.") } }
        }
    }
    @Command fun upload(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try { vault.configure(args.getString("origin"), args.getString("pairingToken")); val result = vault.upload(controller.store, args.getString("sourceRecordingId")); main.post { invoke.resolve(JSObject(result.toString())) } }
            catch (e: Exception) { main.post { invoke.reject(e.message ?: "Upload failed; local audio retained.") } }
        }
    }
    @Command fun play(invoke: Invoke) = guarded(invoke) {
        val id = invoke.getArgs().getString("sourceRecordingId")
        player?.release()
        player = MediaPlayer().apply {
            setDataSource(controller.store.file(id).absolutePath)
            setOnPreparedListener { it.start(); playingId = id }
            setOnCompletionListener { playingId = null }
            setOnErrorListener { _, _, _ -> playingId = null; true }; prepareAsync()
        }
    }
    @Command fun stopPlayback(invoke: Invoke) = guarded(invoke) { player?.release(); player = null; playingId = null }
    @Command fun exportDocument(invoke: Invoke) = guarded(invoke) { val a = invoke.getArgs(); PlaudExports(activity).document(a.getString("filename"), a.getString("content"), a.getString("mime")) }
    @Command fun exportRecording(invoke: Invoke) = guarded(invoke) { PlaudExports(activity).audio(controller.store.file(invoke.getArgs().getString("sourceRecordingId"))) }
    @Command fun exportVaultRecording(invoke: Invoke) {
        val args = invoke.getArgs()
        worker.execute {
            try { vault.configure(args.getString("origin"), args.getString("pairingToken")); val file = vault.exportAudio(File(activity.cacheDir, "document-exports"), args.getString("recordingId"), args.getString("filename")); main.post { guarded(invoke) { PlaudExports(activity).audio(file) } } }
            catch (e: Exception) { main.post { invoke.reject(e.message ?: "Audio export failed.") } }
        }
    }

    // Bluetooth sync: this phone serves its voice recordings to the paired desktop (PhoneBleServer).
    private fun phoneBleValue(): JSObject {
        val preferences = PhoneBleSyncService.preferences(activity)
        return JSObject().put("enabled", preferences.getBoolean("enabled", false)).put("active", PhoneBleSyncService.active)
            .put("status", PhoneBleSyncService.status).put("clientId", preferences.getString("clientId", null) ?: org.json.JSONObject.NULL)
    }
    private fun phoneBleAliases() = when {
        Build.VERSION.SDK_INT >= 33 -> arrayOf("bluetoothServer", "audioRecordings", "notifications")
        Build.VERSION.SDK_INT >= 31 -> arrayOf("bluetoothServer", "storage")
        else -> arrayOf("storage")
    }
    @Command fun phoneBleStatus(invoke: Invoke) = invoke.resolve(phoneBleValue())

    // The phone's own recording library (PhoneRecordings): permanent, and listed with whether the
    // paired desktop has confirmed it holds a copy.
    private fun libraryValue(): JSObject {
        val onDesktop = PhoneRecordings.onDesktop(activity)
        val offered = PhoneRecordings.offered(activity)
        val published = PhoneRecordings.published(activity)
        val items = org.json.JSONArray()
        PhoneRecordings.outboxItems(activity).forEach { item ->
            items.put(org.json.JSONObject().put("id", item.id.toString()).put("name", item.name).put("size", item.size)
                .put("addedAt", item.recordedAt ?: org.json.JSONObject.NULL).put("onDesktop", item.id in onDesktop).put("send", item.id in offered)
                .put("inFolder", item.id in published))
        }
        val value = JSObject().put("recordings", items).put("folder", PhoneRecordings.PUBLIC_FOLDER)
        value.put("autoSend", PhoneRecordings.autoSend(activity))
        return value
    }
    /** Runs library work off the main thread and answers with the updated library. */
    private fun libraryCommand(invoke: Invoke, failure: String, work: () -> Unit) = worker.execute {
        try { work(); val value = libraryValue(); main.post { invoke.resolve(value) } }
        catch (e: Exception) { main.post { invoke.reject(e.message ?: failure) } }
    }
    @Command fun phoneLibrary(invoke: Invoke) = libraryCommand(invoke, "The phone library could not be read.") { PhoneRecordings.publishEarlier(activity) }
    /** Marks one recording to be copied by the desktop, or takes it back; the phone keeps it either way. */
    @Command fun phoneSetSend(invoke: Invoke) = libraryCommand(invoke, "The recording could not be updated.") {
        val id = invoke.getArgs().getString("id").toLong()
        check(PhoneRecordings.exists(activity, id)) { "This recording is no longer on the phone." }
        PhoneRecordings.setOffered(activity, id, invoke.getArgs().getBoolean("send"))
    }
    /** Reads part of a library recording so the web view can upload it to the paired computer over Wi-Fi. */
    @Command fun phoneRecordingRead(invoke: Invoke) = worker.execute {
        try {
            val args = invoke.getArgs()
            val bytes = PhoneRecordings.readLibrary(activity, args.getString("id").toLong(), args.getLong("offset"), args.getInt("length"))
            main.post { invoke.resolve(JSObject().put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))) }
        } catch (e: Exception) { main.post { invoke.reject(e.message ?: "The recording could not be read.") } }
    }
    /** The computer confirmed it holds this recording (uploaded over Wi-Fi). */
    @Command fun phoneMarkOnDesktop(invoke: Invoke) = libraryCommand(invoke, "The recording could not be updated.") {
        PhoneRecordings.markOnDesktop(activity, listOf(invoke.getArgs().getString("id").toLong()))
    }
    @Command fun phoneSetAutoSend(invoke: Invoke) = libraryCommand(invoke, "The setting could not be saved.") {
        PhoneRecordings.setAutoSend(activity, invoke.getArgs().getBoolean("enabled"))
    }
    // OpenPlod's own recorder hands its audio over in base64 chunks, then names it.
    @Command fun phoneRecordingBegin(invoke: Invoke) = worker.execute {
        try { val upload = PhoneRecordings.beginRecording(activity); main.post { invoke.resolve(JSObject().put("upload", upload)) } }
        catch (e: Exception) { main.post { invoke.reject(e.message ?: "The recording could not be saved on this phone.") } }
    }
    @Command fun phoneRecordingAppend(invoke: Invoke) = worker.execute {
        try {
            val args = invoke.getArgs()
            PhoneRecordings.appendRecording(activity, args.getString("upload"), android.util.Base64.decode(args.getString("data"), android.util.Base64.NO_WRAP))
            main.post { invoke.resolve(JSObject()) }
        } catch (e: Exception) { main.post { invoke.reject(e.message ?: "The recording could not be saved on this phone.") } }
    }
    @Command fun phoneRecordingFinish(invoke: Invoke) {
        val args = invoke.getArgs()
        var saved = 0L
        libraryCommand(invoke, "The recording could not be saved on this phone.") {
            saved = PhoneRecordings.finishRecording(activity, args.getString("upload"), args.getString("name"), args.getBoolean("send"))
            android.util.Log.i("OpenPlodShare", "saved in-app recording $saved on the phone")
        }
    }
    // Native recorder (RecordingService): keeps recording with the screen off or the phone locked.
    private fun recorderValue() = JSObject(RecordingService.status(activity).toString())
    @Command fun recordStatus(invoke: Invoke) = invoke.resolve(recorderValue())
    @Command fun recordStart(invoke: Invoke) =
        requestPermissionForAliases(if (Build.VERSION.SDK_INT >= 33) arrayOf("microphone", "notifications") else arrayOf("microphone"), invoke, "recordPermissions")
    @PermissionCallback fun recordPermissions(invoke: Invoke) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { invoke.reject("Microphone access is off. Allow OpenPlod in your system settings, then try again."); return }
        try { RecordingService.start(activity) } catch (e: Exception) { invoke.reject(e.message ?: "The microphone could not be started."); return }
        // The service starts the microphone once it is in the foreground; answer when it has.
        var waited = 0
        main.post(object : Runnable {
            override fun run() {
                val value = recorderValue()
                if (value.getString("state") == "starting" && waited++ < 50) { main.postDelayed(this, 100); return }
                if (value.getString("state") == "recording") invoke.resolve(value)
                else invoke.reject(value.optString("error").takeIf { it.isNotBlank() && it != "null" } ?: "The microphone could not be started.")
            }
        })
    }
    @Command fun recordPause(invoke: Invoke) { RecordingService.pause(activity); invoke.resolve(recorderValue()) }
    @Command fun recordResume(invoke: Invoke) { RecordingService.resume(activity); invoke.resolve(recorderValue()) }
    @Command fun recordStop(invoke: Invoke) { RecordingService.stop(activity); invoke.resolve(recorderValue()) }
    @Command fun recordRead(invoke: Invoke) = worker.execute {
        try {
            val args = invoke.getArgs()
            val bytes = RecordingService.read(activity, args.getString("take"), args.getLong("offset"), args.getInt("length"))
            main.post { invoke.resolve(JSObject().put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))) }
        } catch (e: Exception) { main.post { invoke.reject(e.message ?: "The recording could not be read.") } }
    }
    @Command fun recordKeep(invoke: Invoke) {
        val args = invoke.getArgs()
        libraryCommand(invoke, "The recording could not be saved on this phone.") {
            RecordingService.keep(activity, args.getString("take"), args.getString("name"), args.getBoolean("send"))
        }
    }
    @Command fun recordDiscard(invoke: Invoke) { RecordingService.discard(activity, invoke.getArgs().getString("take")); invoke.resolve(recorderValue()) }

    /** Opens Android's file picker for audio; picked files are copied into the phone library. */
    @Command fun phonePickRecordings(invoke: Invoke) {
        // Audio, plus video containers recorders use (3GP, MP4, MOV, MKV, WebM) and files a
        // file manager labels generically; anything picked that is not a recording format is skipped.
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("audio/*", "video/*", "application/ogg", "application/octet-stream"))
        startActivityForResult(invoke, intent, "phonePickResult")
    }
    @ActivityCallback fun phonePickResult(invoke: Invoke, result: androidx.activity.result.ActivityResult) {
        val data = result.data
        val uris = when {
            result.resultCode != Activity.RESULT_OK || data == null -> emptyList()
            data.clipData != null -> (0 until data.clipData!!.itemCount).map { data.clipData!!.getItemAt(it).uri }
            else -> listOfNotNull(data.data)
        }
        worker.execute {
            var added = 0; val skipped = org.json.JSONArray()
            for (uri in uris) {
                val name = runCatching {
                    activity.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
                }.getOrNull() ?: uri.lastPathSegment ?: "Recording.m4a"
                val type = runCatching { activity.contentResolver.getType(uri) }.getOrNull().orEmpty()
                if (!type.startsWith("audio/") && !PhoneRecordings.isAudioName(name)) { skipped.put(name); continue }
                runCatching { PhoneRecordings.keep(activity, uri, name); added++ }.onFailure { skipped.put(name) }
            }
            val value = libraryValue()
            value.put("added", added); value.put("skipped", skipped)
            main.post { invoke.resolve(value) }
        }
    }
    /** An app update or reboot stops the sync service; bring it back when the app opens if it was on. */
    override fun load(webView: android.webkit.WebView) {
        super.load(webView)
        if (PhoneBleSyncService.preferences(activity).getBoolean("enabled", false) && !PhoneBleSyncService.active) {
            val intent = Intent(activity, PhoneBleSyncService::class.java)
            runCatching { if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent) else activity.startService(intent) }
        }
    }
    @Command fun phoneBleSync(invoke: Invoke) {
        val args = invoke.getArgs()
        if (!args.getBoolean("enabled")) {
            PhoneBleSyncService.preferences(activity).edit().putBoolean("enabled", false).apply()
            activity.stopService(Intent(activity, PhoneBleSyncService::class.java))
            invoke.resolve(phoneBleValue()); return
        }
        val clientId = args.getString("clientId")
        val token = args.getString("pairingToken")
        if (clientId.isNullOrBlank() || token.isNullOrBlank()) { invoke.reject("Pair this phone with the desktop first."); return }
        // The key is derived here and the token itself is not kept by the Bluetooth service.
        PhoneBleSyncService.preferences(activity).edit().putString("clientId", clientId)
            .putString("key", android.util.Base64.encodeToString(PhoneBleProtocol.key(token), android.util.Base64.NO_WRAP)).apply()
        requestPermissionForAliases(phoneBleAliases(), invoke, "phoneBlePermissions")
    }
    @PermissionCallback fun phoneBlePermissions(invoke: Invoke) {
        val missing = phoneBleAliases().filter { it != "notifications" && getPermissionState(it) != PermissionState.GRANTED }
        if (missing.isNotEmpty()) { invoke.reject(if ("bluetoothServer" in missing) "Allow Nearby devices so the desktop can find this phone." else "Allow access to audio so the desktop can copy your recordings."); return }
        PhoneBleSyncService.preferences(activity).edit().putBoolean("enabled", true).apply()
        val intent = Intent(activity, PhoneBleSyncService::class.java)
        if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent) else activity.startService(intent)
        invoke.resolve(phoneBleValue())
    }
}
