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
 * Voice recordings on this phone, as the desktop sees them over Bluetooth: the system voice
 * recorder's files (MediaStore `IS_RECORDING` on Android 12+, or audio under a recordings
 * folder on older versions). Music and ringtones are never offered.
 */
class PhoneRecordings(private val context: Context) {
    data class Item(val id: Long, val size: Long, val name: String, val recordedAt: Long?, val mime: String)

    private val collection: Uri = if (Build.VERSION.SDK_INT >= 29) MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL) else MediaStore.Audio.Media.EXTERNAL_CONTENT_URI

    fun list(limit: Int = 500): List<Item> {
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
}
