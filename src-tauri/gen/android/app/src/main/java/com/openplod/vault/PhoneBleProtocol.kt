package com.openplod.vault

import android.util.Base64
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * "OpenPlod Phone" Bluetooth LE protocol, phone side (GATT peripheral). The desktop is the
 * central. Keep in sync with `src/devices/phone/protocol.ts`:
 * - one UTF-8 JSON request per write on [WRITE_UUID];
 * - replies are notifications on [NOTIFY_UUID] starting with a kind byte: 'J' (JSON fragment,
 *   more follow), 'j' (last JSON fragment) or 'B' (audio bytes for the current `get`);
 * - both sides prove the pairing key (SHA-256 of this phone's pairing token) with an HMAC over
 *   both nonces, bound to the direction ("phone" or "desktop");
 * - the radio link is not bonded, so the recording list and audio chunks are sealed with
 *   AES-256-GCM under a per-session key ([sessionKey]).
 */
object PhoneBleProtocol {
    val SERVICE_UUID: UUID = UUID.fromString("7f1e0001-5c6a-4b8e-9d1a-0a9e0f9c4f10")
    val NOTIFY_UUID: UUID = UUID.fromString("7f1e0002-5c6a-4b8e-9d1a-0a9e0f9c4f10")
    val WRITE_UUID: UUID = UUID.fromString("7f1e0003-5c6a-4b8e-9d1a-0a9e0f9c4f10")
    /** Client Characteristic Configuration descriptor, which the central writes to subscribe. */
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    const val VERSION = 1
    const val JSON_MORE: Byte = 0x4a
    const val JSON_LAST: Byte = 0x6a
    const val BINARY: Byte = 0x42
    /** Largest `get` the desktop may ask for; it asks for 64 KiB. */
    const val MAX_CHUNK = 256 * 1024

    fun key(pairingToken: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(pairingToken.toByteArray(Charsets.UTF_8))

    fun proof(key: ByteArray, role: String, desktopNonce: String, phoneNonce: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        val digest = mac.doFinal("openplod-phone/v1|$role|$desktopNonce|$phoneNonce".toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(digest, Base64.NO_WRAP)
    }

    fun verify(key: ByteArray, role: String, desktopNonce: String, phoneNonce: String, supplied: String): Boolean {
        val expected = Base64.decode(proof(key, role, desktopNonce, phoneNonce), Base64.NO_WRAP)
        val actual = try { Base64.decode(supplied, Base64.NO_WRAP) } catch (_: IllegalArgumentException) { return false }
        return MessageDigest.isEqual(expected, actual)
    }

    /** Per-session AES key: HKDF-SHA256(ikm = pairing key, salt = "desktopNonce|phoneNonce"). */
    fun sessionKey(key: ByteArray, desktopNonce: String, phoneNonce: String): ByteArray {
        val extract = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec("$desktopNonce|$phoneNonce".toByteArray(Charsets.UTF_8), "HmacSHA256")) }
        val prk = extract.doFinal(key)
        val expand = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }
        return expand.doFinal("openplod-phone/v1 session".toByteArray(Charsets.UTF_8) + byteArrayOf(1)).copyOf(32)
    }

    /** `iv(12) | ciphertext | tag(16)`, AES-256-GCM, like `seal()` in protocol.ts. */
    fun seal(key: ByteArray, plaintext: ByteArray, random: java.security.SecureRandom): ByteArray {
        val iv = ByteArray(12).also(random::nextBytes)
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), javax.crypto.spec.GCMParameterSpec(128, iv))
        return iv + cipher.doFinal(plaintext)
    }

    fun sha256Hex(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(bytes, offset, length)
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Splits a JSON reply into notification payloads of at most [frameBytes]. */
    fun replyFrames(value: JSONObject, frameBytes: Int): List<ByteArray> {
        val body = value.toString().toByteArray(Charsets.UTF_8)
        val step = frameBytes - 1
        val frames = ArrayList<ByteArray>()
        var offset = 0
        do {
            val end = minOf(body.size, offset + step)
            frames += byteArrayOf(if (end >= body.size) JSON_LAST else JSON_MORE) + body.copyOfRange(offset, end)
            offset = end
        } while (offset < body.size)
        return frames
    }

    fun binaryFrames(bytes: ByteArray, length: Int, frameBytes: Int): List<ByteArray> {
        val step = frameBytes - 1
        val frames = ArrayList<ByteArray>((length + step - 1) / step)
        var offset = 0
        while (offset < length) {
            val end = minOf(length, offset + step)
            frames += byteArrayOf(BINARY) + bytes.copyOfRange(offset, end)
            offset = end
        }
        return frames
    }

    fun error(code: String, message: String): JSONObject = JSONObject().put("op", "error").put("code", code).put("message", message)
}
