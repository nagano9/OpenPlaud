package com.openplod.vault

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.security.SecureRandom
import java.util.ArrayDeque
import java.util.concurrent.Executors

/**
 * Serves this phone's voice recordings to the paired OpenPlod desktop over Bluetooth LE
 * (protocol in [PhoneBleProtocol]). The phone advertises the OpenPlod Phone service; the
 * desktop connects, both sides prove the pairing key, then the desktop lists recordings and
 * reads them in checksummed chunks sealed with a per-session key. No Bluetooth pairing dialog is
 * needed. Nothing is ever deleted.
 */
@SuppressLint("MissingPermission")
class PhoneBleServer(private val context: Context, private val clientId: String, private val key: ByteArray) {
    private val manager = context.getSystemService(BluetoothManager::class.java)
    private val recordings = PhoneRecordings(context)
    private val worker = Executors.newSingleThreadExecutor()
    private val random = SecureRandom()
    private val lock = Any()
    private var server: BluetoothGattServer? = null
    private var notify: BluetoothGattCharacteristic? = null
    private var central: BluetoothDevice? = null
    private var frameBytes = 20
    private val pending = ArrayDeque<ByteArray>()
    private var sending = false
    private var desktopNonce = ""
    private var phoneNonce = ""
    private var authenticated = false
    private var sessionKey = ByteArray(0)
    private val prepared = HashMap<String, ByteArray>()
    private val mtus = HashMap<String, Int>()
    @Volatile var lastEvent: String = "Waiting for the desktop"
        private set

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) { lastEvent = "Bluetooth advertising failed ($errorCode)"; Log.w(TAG, lastEvent) }
    }

    fun start() {
        val adapter = manager?.adapter ?: error("This phone has no Bluetooth.")
        check(adapter.isEnabled) { "Turn on Bluetooth." }
        val advertiser = adapter.bluetoothLeAdvertiser ?: error("This phone cannot advertise over Bluetooth LE.")
        val gatt = manager.openGattServer(context, callback) ?: error("Bluetooth server could not start.")
        val service = BluetoothGattService(PhoneBleProtocol.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        // No OS-level bonding: Windows does not pair a phone's rotating LE address on its own, so the
        // app authenticates both sides and seals private data itself (PhoneBleProtocol).
        val replies = BluetoothGattCharacteristic(PhoneBleProtocol.NOTIFY_UUID, BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_READ)
        replies.addDescriptor(BluetoothGattDescriptor(PhoneBleProtocol.CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
        val requests = BluetoothGattCharacteristic(PhoneBleProtocol.WRITE_UUID, BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE)
        service.addCharacteristic(replies); service.addCharacteristic(requests)
        gatt.addService(service)
        server = gatt; notify = replies
        advertiser.startAdvertising(
            AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED).setConnectable(true).setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).build(),
            AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(PhoneBleProtocol.SERVICE_UUID)).build(),
            advertiseCallback)
        lastEvent = "Waiting for the desktop"
    }

    fun stop() {
        runCatching { manager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
        runCatching { server?.close() }
        server = null; central = null
        worker.shutdownNow()
    }

    private val callback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            // Android reports every LE link to the phone here (watches, earbuds, other apps' peers),
            // not only links to this service, so a connection alone never makes a device the desktop
            // and nothing is ever disconnected from here.
            synchronized(lock) {
                if (newState != BluetoothProfile.STATE_CONNECTED) {
                    mtus.remove(device.address)
                    if (central?.address == device.address) {
                        central = null; authenticated = false; pending.clear(); sending = false
                        lastEvent = "Desktop disconnected"
                    }
                }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            synchronized(lock) {
                mtus[device.address] = mtu
                if (central?.address == device.address) frameBytes = (mtu - 3).coerceIn(20, 509)
            }
        }

        override fun onDescriptorWriteRequest(device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
            // Subscribing to OpenPlod replies is what makes a device the desktop of this session.
            // The newest subscriber wins and must authenticate again; a stale one cannot block it.
            if (descriptor.uuid == PhoneBleProtocol.CCCD_UUID && descriptor.characteristic.uuid == PhoneBleProtocol.NOTIFY_UUID) synchronized(lock) {
                if (value.isNotEmpty() && value[0].toInt() != 0) {
                    central = device; authenticated = false; sessionKey = ByteArray(0); pending.clear(); sending = false
                    frameBytes = ((mtus[device.address] ?: 23) - 3).coerceIn(20, 509)
                    lastEvent = "Desktop connected"
                } else if (central?.address == device.address) {
                    central = null; authenticated = false; pending.clear(); sending = false
                }
            }
            if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        }

        override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
            val ours = characteristic.uuid == PhoneBleProtocol.WRITE_UUID && central?.address == device.address
            if (responseNeeded) server?.sendResponse(device, requestId, if (ours) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, null)
            if (!ours) return
            if (preparedWrite) {
                // Long writes arrive in pieces and are applied on execute.
                synchronized(lock) { prepared[device.address] = (prepared[device.address] ?: ByteArray(0)) + value }
                return
            }
            val request = value.copyOf()
            worker.execute { handle(device, request) }
        }

        override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
            server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            val request = synchronized(lock) { prepared.remove(device.address) } ?: return
            if (execute) worker.execute { handle(device, request) }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) { synchronized(lock) { sending = false }; pump() }
    }

    private fun handle(device: BluetoothDevice, raw: ByteArray) {
        val request = try { JSONObject(String(raw, Charsets.UTF_8)) } catch (_: Exception) { reply(device, PhoneBleProtocol.error("invalid", "Request is not JSON")); return }
        try {
            when (request.optString("op")) {
                "hello" -> {
                    if (request.optInt("version") != PhoneBleProtocol.VERSION) { reply(device, PhoneBleProtocol.error("version", "Update OpenPlod on the desktop or phone")); return }
                    val nonce = ByteArray(16).also(random::nextBytes)
                    synchronized(lock) { desktopNonce = request.getString("nonce").take(64); phoneNonce = Base64.encodeToString(nonce, Base64.NO_WRAP); authenticated = false }
                    reply(device, JSONObject().put("op", "hello").put("version", PhoneBleProtocol.VERSION).put("clientId", clientId)
                        .put("device", "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(120)).put("nonce", phoneNonce)
                        .put("proof", PhoneBleProtocol.proof(key, "phone", desktopNonce, phoneNonce)))
                }
                "auth" -> {
                    val ok = desktopNonce.isNotEmpty() && PhoneBleProtocol.verify(key, "desktop", desktopNonce, phoneNonce, request.optString("proof"))
                    synchronized(lock) { authenticated = ok; sessionKey = if (ok) PhoneBleProtocol.sessionKey(key, desktopNonce, phoneNonce) else ByteArray(0) }
                    lastEvent = if (ok) "Syncing with the desktop" else "A desktop failed to prove its pairing"
                    reply(device, if (ok) JSONObject().put("op", "ready") else PhoneBleProtocol.error("auth", "This desktop is not the one this phone is paired with"))
                }
                "bye" -> lastEvent = "Synced with the desktop"
                else -> {
                    if (!authenticated) { reply(device, PhoneBleProtocol.error("auth", "Not authenticated")); return }
                    when (request.optString("op")) {
                        "list" -> {
                            val sealed = PhoneBleProtocol.seal(sessionKey, recordings.json(recordings.list()).toString().toByteArray(Charsets.UTF_8), random)
                            reply(device, JSONObject().put("op", "list").put("sealed", Base64.encodeToString(sealed, Base64.NO_WRAP)))
                        }
                        "get" -> {
                            val id = request.getLong("id"); val offset = request.getLong("offset"); val length = request.getInt("length")
                            val bytes = recordings.read(id, offset, length)
                            val sealed = PhoneBleProtocol.seal(sessionKey, bytes, random)
                            val frames = PhoneBleProtocol.binaryFrames(sealed, sealed.size, frameBytes)
                            enqueue(device, frames + PhoneBleProtocol.replyFrames(JSONObject().put("op", "chunk").put("id", id).put("offset", offset)
                                .put("length", bytes.size).put("sha256", PhoneBleProtocol.sha256Hex(bytes)), frameBytes))
                        }
                        "imported" -> {
                            // The desktop now holds these recordings; the phone keeps its own copies.
                            val ids = request.optJSONArray("ids")
                            PhoneRecordings.markOnDesktop(context, (0 until (ids?.length() ?: 0)).map { ids!!.getLong(it) })
                            lastEvent = "Synced with the desktop"
                            reply(device, JSONObject().put("op", "ok"))
                        }
                        else -> reply(device, PhoneBleProtocol.error("unknown", "Unknown request"))
                    }
                }
            }
        } catch (error: Exception) {
            reply(device, PhoneBleProtocol.error("failed", error.message?.take(300) ?: "Request failed"))
        }
    }

    private fun reply(device: BluetoothDevice, value: JSONObject) = enqueue(device, PhoneBleProtocol.replyFrames(value, frameBytes))

    private fun enqueue(device: BluetoothDevice, frames: List<ByteArray>) {
        synchronized(lock) { if (central?.address != device.address) return; pending.addAll(frames) }
        pump()
    }

    /** Sends the next notification once the previous one was handed to the radio. */
    private fun pump() {
        val (device, characteristic, frame) = synchronized(lock) {
            if (sending) return
            val device = central ?: return
            val characteristic = notify ?: return
            val frame = pending.pollFirst() ?: return
            sending = true
            Triple(device, characteristic, frame)
        }
        val started = if (Build.VERSION.SDK_INT >= 33) {
            server?.notifyCharacteristicChanged(device, characteristic, false, frame) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            characteristic.value = frame
            @Suppress("DEPRECATION")
            server?.notifyCharacteristicChanged(device, characteristic, false) == true
        }
        if (!started) synchronized(lock) { sending = false; pending.addFirst(frame) }
    }

    companion object { private const val TAG = "OpenPlodPhoneBle" }
}
