package com.openplod.vault

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Transcribes phone library recordings with the person's own OpenAI key, without the computer.
 * The key is encrypted with an Android Keystore key that never leaves the phone; the web view
 * never reads it back. Transcripts are kept next to the library as transcripts/<id>.json.
 */
object PhoneTranscriber {
    const val MODEL = "gpt-transcribe"
    // OpenAI takes at most 25 MB per request; pieces also stay well under the models' length limit.
    private const val MAX_BYTES = 24L * 1000 * 1000
    private const val PIECE_SECONDS = 15 * 60
    private const val ALIAS = "openplod-transcription"
    private val splittable = setOf("m4a", "mp4", "3gp", "aac")

    private val http = OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.MINUTES).readTimeout(10, TimeUnit.MINUTES).build()

    private fun preferences(context: Context) = context.getSharedPreferences("transcription", Context.MODE_PRIVATE)

    // --- API key -------------------------------------------------------------------------------

    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    /** Checks the key with OpenAI, then stores it encrypted. */
    fun saveKey(context: Context, key: String) {
        val clean = key.trim()
        require(clean.startsWith("sk-") && clean.length in 20..400) { "This does not look like an OpenAI API key (it starts with sk-)." }
        check(clean)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret()) }
        val sealed = cipher.iv + cipher.doFinal(clean.toByteArray())
        preferences(context).edit().putString("key", Base64.encodeToString(sealed, Base64.NO_WRAP)).putString("hint", clean.takeLast(4)).apply()
    }

    fun clearKey(context: Context) { preferences(context).edit().remove("key").remove("hint").apply() }

    private fun key(context: Context): String {
        val sealed = preferences(context).getString("key", null)?.let { Base64.decode(it, Base64.NO_WRAP) }
            ?: throw IOException("Add your OpenAI API key first.")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, sealed, 0, 12)) }
        return String(cipher.doFinal(sealed, 12, sealed.size - 12))
    }

    private fun check(key: String) {
        val request = Request.Builder().url("https://api.openai.com/v1/models").header("Authorization", "Bearer $key").build()
        http.newCall(request).execute().use { response ->
            if (response.code == 401) throw IOException("OpenAI did not accept this key.")
            if (!response.isSuccessful) throw IOException("OpenAI could not be reached (HTTP ${response.code}).")
        }
    }

    fun language(context: Context) = preferences(context).getString("language", "") ?: ""
    fun setLanguage(context: Context, language: String) {
        require(language.isEmpty() || language.matches(Regex("[a-z]{2}"))) { "Invalid language." }
        preferences(context).edit().putString("language", language).apply()
    }

    fun settings(context: Context): JSONObject = JSONObject()
        .put("hasKey", preferences(context).contains("key"))
        .put("keyHint", preferences(context).getString("hint", null) ?: JSONObject.NULL)
        .put("language", language(context)).put("model", MODEL)

    // --- Transcripts ---------------------------------------------------------------------------

    private fun transcripts(context: Context) = File(context.filesDir, "transcripts").apply { mkdirs() }
    private fun transcriptFile(context: Context, id: Long) = File(transcripts(context), "$id.json")
    fun transcribed(context: Context): Set<Long> = (transcripts(context).listFiles() ?: emptyArray())
        .mapNotNull { it.name.removeSuffix(".json").toLongOrNull() }.toSet()
    fun transcript(context: Context, id: Long): JSONObject {
        val file = transcriptFile(context, id)
        if (!file.exists()) throw IOException("This recording has no transcript yet.")
        return JSONObject(file.readText())
    }

    /** Progress for the list: id -> {state, done, total, error}. */
    val jobs = java.util.concurrent.ConcurrentHashMap<Long, JSONObject>()

    fun jobsValue(): JSONObject = JSONObject().apply { jobs.forEach { (id, job) -> put(id.toString(), job) } }

    /** Transcribes one library recording, piece by piece, and stores the transcript. */
    fun transcribe(context: Context, id: Long) {
        val source = PhoneRecordings.libraryFile(context, id) ?: throw IOException("This recording is no longer on the phone.")
        val key = key(context)
        val work = File(context.cacheDir, "transcription-$id").apply { deleteRecursively(); mkdirs() }
        try {
            val pieces = pieces(source, work)
            jobs[id] = JSONObject().put("state", "running").put("done", 0).put("total", pieces.size)
            val texts = mutableListOf<String>()
            val segments = JSONArray()
            var detected: String? = null
            pieces.forEachIndexed { index, piece ->
                val (text, language) = request(key, piece.file, language(context))
                detected = detected ?: language
                if (text.isNotBlank()) {
                    texts += text.trim()
                    segments.put(JSONObject().put("start", piece.start).put("end", piece.end).put("text", text.trim()))
                }
                jobs[id] = JSONObject().put("state", "running").put("done", index + 1).put("total", pieces.size)
            }
            val duration = pieces.lastOrNull()?.end ?: 0.0
            val value = JSONObject().put("text", texts.joinToString("\n\n")).put("segments", segments)
                .put("model", MODEL).put("language", detected ?: language(context).ifEmpty { null } ?: JSONObject.NULL)
                .put("durationSeconds", duration).put("pieces", pieces.size).put("createdAt", System.currentTimeMillis())
            transcriptFile(context, id).writeText(value.toString())
            jobs.remove(id)
        } catch (error: Exception) {
            jobs[id] = JSONObject().put("state", "failed").put("error", error.message ?: "Transcription failed.")
            throw error
        } finally { work.deleteRecursively() }
    }

    private class Piece(val file: File, val start: Double, val end: Double)

    private fun durationSeconds(file: File): Double = runCatching {
        MediaMetadataRetriever().run { try { setDataSource(file.absolutePath); extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDouble()?.div(1000) } finally { release() } }
    }.getOrNull() ?: 0.0

    /**
     * AAC recordings (OpenPlod's own, most phone recorders) are cut into 15-minute pieces without
     * re-encoding. Other formats are sent whole and must fit OpenAI's 25 MB limit.
     */
    private fun pieces(source: File, work: File): List<Piece> {
        val extension = source.name.substringAfterLast('.', "").lowercase()
        val duration = durationSeconds(source)
        val upload = { name: String -> File(work, name).also { source.copyTo(it) } }
        if (extension !in splittable || (source.length() <= MAX_BYTES && duration <= PIECE_SECONDS + 60)) {
            if (source.length() > MAX_BYTES) throw IOException("This recording is larger than 25 MB and its format cannot be split on the phone. Send it to the computer to transcribe it.")
            // OpenAI names WebM by extension; the shared-folder copy is .mka but the audio is WebM.
            val name = when (extension) { "mka" -> "audio.webm"; "opus" -> "audio.ogg"; "" -> "audio.m4a"; else -> "audio.$extension" }
            return listOf(Piece(upload(name), 0.0, duration))
        }
        return split(source, work)
    }

    private fun split(source: File, work: File): List<Piece> {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(source.absolutePath)
            val track = (0 until extractor.trackCount).firstOrNull { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                ?: throw IOException("No audio track was found in this recording.")
            extractor.selectTrack(track)
            val format = extractor.getTrackFormat(track)
            val buffer = ByteBuffer.allocate(if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) maxOf(format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE), 64 * 1024) else 1 shl 20)
            val info = android.media.MediaCodec.BufferInfo()
            val pieces = mutableListOf<Piece>()
            var muxer: MediaMuxer? = null
            var muxerTrack = -1
            var pieceStartUs = 0L
            var lastUs = 0L
            var file: File? = null
            fun close() {
                val current = muxer ?: return
                current.stop(); current.release(); muxer = null
                pieces += Piece(file!!, pieceStartUs / 1e6, lastUs / 1e6)
            }
            while (true) {
                val size = extractor.readSampleData(buffer, 0)
                if (size < 0) break
                val time = extractor.sampleTime
                if (muxer == null || time - pieceStartUs >= PIECE_SECONDS * 1_000_000L) {
                    close()
                    file = File(work, "piece-${pieces.size + 1}.m4a")
                    muxer = MediaMuxer(file!!.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                    muxerTrack = muxer!!.addTrack(format); muxer!!.start(); pieceStartUs = time
                }
                info.set(0, size, time - pieceStartUs, android.media.MediaCodec.BUFFER_FLAG_KEY_FRAME)
                muxer!!.writeSampleData(muxerTrack, buffer, info)
                lastUs = time
                extractor.advance()
            }
            close()
            if (pieces.isEmpty()) throw IOException("This recording has no audio.")
            return pieces
        } finally { extractor.release() }
    }

    private fun request(key: String, file: File, language: String): Pair<String, String?> {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("model", MODEL).addFormDataPart("response_format", "json")
            .apply { if (language.isNotEmpty()) addFormDataPart("languages[]", language) }
            .addFormDataPart("file", file.name, file.asRequestBody("application/octet-stream".toMediaType())).build()
        val request = Request.Builder().url("https://api.openai.com/v1/audio/transcriptions").header("Authorization", "Bearer $key").post(body).build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                // OpenAI's own reason ("Audio file might be corrupted", "Incorrect API key") says what to fix.
                val reason = runCatching { JSONObject(text).getJSONObject("error").getString("message") }.getOrNull()?.take(200)
                throw IOException("OpenAI could not transcribe this recording (HTTP ${response.code})${reason?.let { ": $it" } ?: "."}")
            }
            val payload = JSONObject(text)
            val detected = payload.optString("language").takeIf { it.isNotBlank() }
                ?: payload.optJSONArray("languages")?.optJSONObject(0)?.optString("code")?.takeIf { it.isNotBlank() }
            return payload.optString("text") to detected
        }
    }
}
