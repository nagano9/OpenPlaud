package com.openplod.vault

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Voice recordings on this phone, as the desktop sees them over Bluetooth:
 * - audio shared to OpenPlod (Share → OpenPlod) while Bluetooth sync is on, kept in the app's own
 *   Bluetooth outbox. Some recorders (Xiaomi HyperOS) keep their files in a private folder no
 *   other app can read, so sharing is the way their recordings reach the desktop;
 * - the system voice recorder's files that Android lists as recordings (MediaStore
 *   `IS_RECORDING` on Android 12+, or audio under a recordings folder on older versions).
 * Music and ringtones are never offered.
 */
class PhoneRecordings(private val context: Context) {
    data class Item(val id: Long, val size: Long, val name: String, val recordedAt: Long?, val mime: String)

    private val collection: Uri = if (Build.VERSION.SDK_INT >= 29) MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL) else MediaStore.Audio.Media.EXTERNAL_CONTENT_URI

    /**
     * What the paired desktop may copy: only library recordings marked "send to computer", plus the
     * system recorder's files when automatic sending is on. Everything else stays on the phone.
     */
    fun list(limit: Int = 500): List<Item> {
        val offered = offered(context)
        val library = outboxItems(context).filter { it.id in offered }
        return (if (autoSend(context)) library + mediaStoreItems(limit) else library).take(limit)
    }

    private fun mediaStoreItems(limit: Int): List<Item> {
        val projection = arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.DATE_ADDED, MediaStore.Audio.Media.MIME_TYPE)
        val (selection, arguments) = when {
            // OpenPlod's own shared copies are already in the library; listing them again would send them twice.
            Build.VERSION.SDK_INT >= 31 -> "${MediaStore.Audio.Media.IS_RECORDING} = 1 AND ${MediaStore.Audio.Media.RELATIVE_PATH} NOT LIKE ?" to arrayOf("%OpenPlod%")
            Build.VERSION.SDK_INT >= 29 -> "(${MediaStore.Audio.Media.RELATIVE_PATH} LIKE ? OR ${MediaStore.Audio.Media.RELATIVE_PATH} LIKE ?) AND ${MediaStore.Audio.Media.IS_MUSIC} = 0 AND ${MediaStore.Audio.Media.RELATIVE_PATH} NOT LIKE ?" to arrayOf("%Record%", "%Sound%", "%OpenPlod%")
            else -> "(${MediaStore.Audio.Media.DATA} LIKE ? OR ${MediaStore.Audio.Media.DATA} LIKE ?) AND ${MediaStore.Audio.Media.IS_MUSIC} = 0" to arrayOf("%/Record%", "%/Sound%")
        }
        val items = ArrayList<Item>()
        context.contentResolver.query(collection, projection, selection, arguments, "${MediaStore.Audio.Media.DATE_ADDED} DESC")?.use { cursor ->
            while (cursor.moveToNext() && items.size < limit) {
                val size = cursor.getLong(1)
                if (size <= 0) continue
                items += Item(cursor.getLong(0), size, cursor.getString(2) ?: "Recording", cursor.getLong(3).takeIf { it > 0 }?.times(1000), cursor.getString(4) ?: "audio/mp4")
            }
        }
        return items
    }

    fun json(items: List<Item>): JSONArray {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return JSONArray().apply {
            items.forEach { item ->
                put(JSONObject().put("id", item.id).put("size", item.size).put("name", item.name.take(240))
                    .put("recordedAt", item.recordedAt?.let { iso.format(Date(it)) } ?: JSONObject.NULL).put("mime", item.mime.take(80)))
            }
        }
    }

    /** Reads `length` bytes at `offset` of one listed recording, or fewer at the end of the file. */
    fun read(id: Long, offset: Long, length: Int): ByteArray {
        require(id >= 0 && offset >= 0 && length in 1..PhoneBleProtocol.MAX_CHUNK) { "Invalid range" }
        // Only what the person chose to send can be read, even by a desktop asking for an unlisted id.
        if (if (id >= OUTBOX_BASE) id !in offered(context) else !autoSend(context)) throw IOException("This recording is kept on the phone")
        if (id >= OUTBOX_BASE) {
            val file = outboxFile(context, id) ?: throw IOException("Recording is no longer available")
            java.io.RandomAccessFile(file, "r").use { input ->
                if (offset >= input.length()) return ByteArray(0)
                input.seek(offset)
                val buffer = ByteArray(minOf(length.toLong(), input.length() - offset).toInt())
                input.readFully(buffer)
                return buffer
            }
        }
        context.contentResolver.openInputStream(ContentUris.withAppendedId(collection, id))?.use { input ->
            var skipped = 0L
            while (skipped < offset) {
                val step = input.skip(offset - skipped)
                if (step <= 0) throw IOException("Recording is shorter than requested")
                skipped += step
            }
            val buffer = ByteArray(length)
            var read = 0
            while (read < length) {
                val count = input.read(buffer, read, length - read)
                if (count < 0) break
                read += count
            }
            return if (read == length) buffer else buffer.copyOf(read)
        } ?: throw IOException("Recording is no longer available")
    }

    companion object {
        /** Library ids sit far above MediaStore row ids: 2^50 + the time the file was added. */
        const val OUTBOX_BASE = 1L shl 50
        /**
         * Recording formats the phone library accepts, with the MIME type sent to the desktop. Keep in
         * step with AUDIO_EXTENSIONS and CONVERTIBLE_AUDIO_EXTENSIONS in src/library/recording-library.ts:
         * the desktop converts everything that is not MP3/M4A/WAV/OGG/WebM/AAC/FLAC and keeps the original.
         */
        private val extensions = mapOf(
            "m4a" to "audio/mp4", "aac" to "audio/aac", "mp3" to "audio/mpeg", "wav" to "audio/wav", "flac" to "audio/flac",
            "ogg" to "audio/ogg", "oga" to "audio/ogg", "opus" to "audio/opus", "webm" to "audio/webm",
            "amr" to "audio/amr", "awb" to "audio/amr-wb", "3gp" to "audio/3gpp", "3g2" to "audio/3gpp2", "3ga" to "audio/3gpp",
            "m4b" to "audio/mp4", "m4r" to "audio/mp4", "wma" to "audio/x-ms-wma", "aif" to "audio/aiff", "aiff" to "audio/aiff", "aifc" to "audio/aiff",
            "caf" to "audio/x-caf", "mka" to "audio/x-matroska", "ac3" to "audio/ac3", "mp2" to "audio/mpeg", "mpga" to "audio/mpeg",
            "mp4" to "video/mp4", "m4v" to "video/mp4", "mov" to "video/quicktime", "mkv" to "video/x-matroska")

        /**
         * The phone's own recording library: audio shared to OpenPlod or picked from files. It is
         * permanent: syncing, pairing, unpairing or re-pairing never deletes from it, and the desktop
         * keeps its own copy. Only the person removes files, from Android's app storage settings.
         */
        private fun outbox(context: Context) = java.io.File(context.filesDir, "bluetooth-outbox").apply { mkdirs() }
        private fun imported(context: Context) = PhoneBleSyncService.preferences(context)

        fun isAudioName(name: String) = name.substringAfterLast('.', "").lowercase() in extensions

        /**
         * Adds a copy of audio to the library; returns its id. `send` marks it for the desktop; by
         * default that follows the "send new recordings automatically" setting.
         */
        fun keep(context: Context, source: java.io.File, name: String, send: Boolean? = null): Long =
            keep(context, name, send) { target -> source.copyTo(target, overwrite = false) }

        /** Adds audio from a content URI (file picker or share) to the library; returns its id. */
        fun keep(context: Context, uri: android.net.Uri, name: String, send: Boolean? = null): Long = keep(context, name, send) { target ->
            (context.contentResolver.openInputStream(uri) ?: throw IOException("The file could not be opened.")).use { input -> target.outputStream().use { input.copyTo(it) } }
        }

        private fun keep(context: Context, name: String, send: Boolean?, write: (java.io.File) -> Unit): Long {
            var id = OUTBOX_BASE + System.currentTimeMillis()
            while (outboxFile(context, id) != null) id++
            val clean = name.replace(Regex("[^\\p{L}\\p{N}._ ()-]"), "_").take(160).ifBlank { "Recording.m4a" }
            val target = java.io.File(outbox(context), "$id-$clean")
            try { write(target) } catch (error: Exception) { target.delete(); throw error }
            offered(context) // settles the one-time migration before this recording is added
            setOffered(context, id, send ?: autoSend(context))
            return id
        }

        // Recordings made with OpenPlod's own recorder arrive from the web view in chunks.
        private fun partial(context: Context, upload: String) = java.io.File(java.io.File(context.filesDir, "recording-uploads").apply { mkdirs() }, "$upload.part")

        fun beginRecording(context: Context): String = java.util.UUID.randomUUID().toString().also { partial(context, it).writeBytes(ByteArray(0)) }

        fun appendRecording(context: Context, upload: String, bytes: ByteArray) {
            require(upload.matches(Regex("[0-9a-f-]{36}"))) { "Invalid recording upload." }
            val file = partial(context, upload)
            check(file.exists()) { "This recording upload has expired. Save again." }
            java.io.FileOutputStream(file, true).use { it.write(bytes) }
        }

        /** Moves a finished recording into the library; returns its id. */
        fun finishRecording(context: Context, upload: String, name: String, send: Boolean): Long {
            require(upload.matches(Regex("[0-9a-f-]{36}"))) { "Invalid recording upload." }
            val file = partial(context, upload)
            check(file.exists() && file.length() > 0) { "The recording is empty." }
            try { return keepRecording(context, file, name, send) } finally { file.delete() }
        }

        /** Adds a recording made in OpenPlod to the library and the shared folder; returns its id. */
        fun keepRecording(context: Context, file: java.io.File, name: String, send: Boolean): Long {
            val id = keep(context, file, name, send)
            outboxFile(context, id)?.let { publish(context, id, it) }
            return id
        }

        /** Where copies of OpenPlod's own recordings appear for file managers and players. */
        val PUBLIC_FOLDER = if (Build.VERSION.SDK_INT >= 31) "${android.os.Environment.DIRECTORY_RECORDINGS}/OpenPlod" else "${android.os.Environment.DIRECTORY_MUSIC}/OpenPlod"

        /**
         * App storage is erased when OpenPlod is uninstalled, so recordings made in the app also get a
         * copy in the shared Recordings/OpenPlod folder (Music/OpenPlod before Android 12), which stays.
         * Needs no permission from Android 10; older versions keep only the app copy.
         */
        private fun publish(context: Context, id: Long, file: java.io.File) {
            if (Build.VERSION.SDK_INT < 29) return
            // Android's media store refuses audio/webm; WebM is Matroska, so the copy is an .mka file.
            val name = file.name.substringAfter('-').replace(Regex("\\.webm$", RegexOption.IGNORE_CASE), ".mka")
            val extension = name.substringAfterLast('.', "").lowercase()
            val resolver = context.contentResolver
            val values = android.content.ContentValues().apply {
                put(MediaStore.Audio.Media.DISPLAY_NAME, name)
                put(MediaStore.Audio.Media.MIME_TYPE, if (extension == "mka") "audio/x-matroska" else extensions[extension] ?: "audio/mp4")
                put(MediaStore.Audio.Media.RELATIVE_PATH, PUBLIC_FOLDER)
                put(MediaStore.Audio.Media.IS_PENDING, 1)
            }
            val uri = try { resolver.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values) }
                catch (error: Exception) { android.util.Log.w("OpenPlodShare", "recording $id could not be added to $PUBLIC_FOLDER: ${error.message}"); null }
                ?: return android.util.Log.w("OpenPlodShare", "recording $id was not added to $PUBLIC_FOLDER").let { }
            try {
                (resolver.openOutputStream(uri) ?: throw IOException("No output")).use { output -> file.inputStream().use { it.copyTo(output) } }
                resolver.update(uri, android.content.ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null)
                val published = imported(context).getStringSet("published", emptySet()).orEmpty()
                imported(context).edit().putStringSet("published", published + id.toString()).commit()
                android.util.Log.i("OpenPlodShare", "recording $id copied to $PUBLIC_FOLDER")
            } catch (error: Exception) {
                resolver.delete(uri, null, null)
                android.util.Log.w("OpenPlodShare", "recording $id could not be copied to $PUBLIC_FOLDER: ${error.message}")
            }
        }

        /**
         * Recordings made in the app before the shared copy existed (WebM is what the in-app recorder
         * writes; shared and picked files already live elsewhere on the phone) get their copy once.
         */
        fun publishEarlier(context: Context) {
            val prefs = imported(context)
            if (Build.VERSION.SDK_INT < 29 || prefs.getBoolean("publishBackfilled", false)) return
            val published = prefs.getStringSet("published", emptySet()).orEmpty()
            (outbox(context).listFiles() ?: emptyArray()).filter { it.name.endsWith(".webm", ignoreCase = true) }.forEach { file ->
                val id = file.name.substringBefore('-').toLongOrNull() ?: return@forEach
                if (id.toString() !in published) publish(context, id, file)
            }
            prefs.edit().putBoolean("publishBackfilled", true).apply()
        }

        fun published(context: Context): Set<Long> = imported(context).getStringSet("published", emptySet()).orEmpty().mapNotNull { it.toLongOrNull() }.toSet()

        /**
         * Recordings marked "send to computer". Before this setting existed every library recording
         * was offered, so on first use those keep being offered and nothing changes silently.
         */
        fun offered(context: Context): Set<Long> {
            val prefs = imported(context)
            if (!prefs.getBoolean("offerMigrated", false)) {
                val existing = (outbox(context).listFiles() ?: emptyArray()).mapNotNull { it.name.substringBefore('-').toLongOrNull()?.toString() }.toSet()
                prefs.edit().putStringSet("offered", existing).putBoolean("offerMigrated", true).commit()
            }
            return prefs.getStringSet("offered", emptySet()).orEmpty().mapNotNull { it.toLongOrNull() }.toSet()
        }

        fun setOffered(context: Context, id: Long, send: Boolean) {
            val current = imported(context).getStringSet("offered", emptySet()).orEmpty()
            imported(context).edit().putStringSet("offered", if (send) current + id.toString() else current - id.toString()).commit()
            android.util.Log.i("OpenPlodShare", "recording $id ${if (send) "will be sent to" else "stays off"} the computer")
        }

        /** "Send new recordings to the computer automatically": off by default, so recordings stay on the phone. */
        fun autoSend(context: Context) = imported(context).getBoolean("autoSend", false)
        fun setAutoSend(context: Context, enabled: Boolean) { imported(context).edit().putBoolean("autoSend", enabled).apply() }

        fun exists(context: Context, id: Long) = outboxFile(context, id) != null

        /** Reads part of a library file for this phone's own UI (no "send" check: nothing leaves without the person). */
        fun readLibrary(context: Context, id: Long, offset: Long, length: Int): ByteArray {
            require(offset >= 0 && length in 1..(1 shl 20)) { "Invalid range" }
            val file = outboxFile(context, id) ?: throw IOException("This recording is no longer on the phone.")
            java.io.RandomAccessFile(file, "r").use { input ->
                if (offset >= input.length()) return ByteArray(0)
                input.seek(offset)
                return ByteArray(minOf(length.toLong(), input.length() - offset).toInt()).also { input.readFully(it) }
            }
        }

        private fun outboxFile(context: Context, id: Long) = outbox(context).listFiles()?.firstOrNull { it.name.startsWith("$id-") }

        fun outboxItems(context: Context): List<Item> = (outbox(context).listFiles() ?: emptyArray()).mapNotNull { file ->
            val id = file.name.substringBefore('-').toLongOrNull() ?: return@mapNotNull null
            val name = file.name.substringAfter('-')
            Item(id, file.length(), name, id - OUTBOX_BASE, extensions[name.substringAfterLast('.', "").lowercase()] ?: "audio/mp4")
        }.sortedByDescending { it.id }

        /** Recordings the desktop confirmed it holds (it says so after each import). */
        fun markOnDesktop(context: Context, ids: List<Long>) {
            val current = imported(context).getStringSet("onDesktop", emptySet()).orEmpty()
            imported(context).edit().putStringSet("onDesktop", current + ids.map(Long::toString)).apply()
        }

        fun onDesktop(context: Context): Set<Long> = imported(context).getStringSet("onDesktop", emptySet()).orEmpty().mapNotNull { it.toLongOrNull() }.toSet()
    }
}
