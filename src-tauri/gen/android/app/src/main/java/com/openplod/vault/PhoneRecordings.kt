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

    fun list(limit: Int = 500): List<Item> = (outboxItems(context) + mediaStoreItems(limit)).take(limit)

    private fun mediaStoreItems(limit: Int): List<Item> {
        val projection = arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.DATE_ADDED, MediaStore.Audio.Media.MIME_TYPE)
        val (selection, arguments) = when {
            Build.VERSION.SDK_INT >= 31 -> "${MediaStore.Audio.Media.IS_RECORDING} = 1" to emptyArray()
            Build.VERSION.SDK_INT >= 29 -> "(${MediaStore.Audio.Media.RELATIVE_PATH} LIKE ? OR ${MediaStore.Audio.Media.RELATIVE_PATH} LIKE ?) AND ${MediaStore.Audio.Media.IS_MUSIC} = 0" to arrayOf("%Record%", "%Sound%")
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
        private val extensions = mapOf("m4a" to "audio/mp4", "mp4" to "audio/mp4", "aac" to "audio/aac", "mp3" to "audio/mpeg", "ogg" to "audio/ogg",
            "opus" to "audio/opus", "wav" to "audio/wav", "flac" to "audio/flac", "amr" to "audio/amr", "3gp" to "audio/3gpp", "3ga" to "audio/3gpp",
            "webm" to "audio/webm", "wma" to "audio/x-ms-wma")

        /**
         * The phone's own recording library: audio shared to OpenPlod or picked from files. It is
         * permanent: syncing, pairing, unpairing or re-pairing never deletes from it, and the desktop
         * keeps its own copy. Only the person removes files, from Android's app storage settings.
         */
        private fun outbox(context: Context) = java.io.File(context.filesDir, "bluetooth-outbox").apply { mkdirs() }
        private fun imported(context: Context) = PhoneBleSyncService.preferences(context)

        fun isAudioName(name: String) = name.substringAfterLast('.', "").lowercase() in extensions

        /** Adds a copy of audio to the library; returns its id. */
        fun keep(context: Context, source: java.io.File, name: String): Long = keep(context, name) { target -> source.copyTo(target, overwrite = false) }

        /** Adds audio from a content URI (file picker or share) to the library; returns its id. */
        fun keep(context: Context, uri: android.net.Uri, name: String): Long = keep(context, name) { target ->
            (context.contentResolver.openInputStream(uri) ?: throw IOException("The file could not be opened.")).use { input -> target.outputStream().use { input.copyTo(it) } }
        }

        private fun keep(context: Context, name: String, write: (java.io.File) -> Unit): Long {
            var id = OUTBOX_BASE + System.currentTimeMillis()
            while (outboxFile(context, id) != null) id++
            val clean = name.replace(Regex("[^\\p{L}\\p{N}._ ()-]"), "_").take(160).ifBlank { "Recording.m4a" }
            val target = java.io.File(outbox(context), "$id-$clean")
            try { write(target) } catch (error: Exception) { target.delete(); throw error }
            return id
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
