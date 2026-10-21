//! Cross-platform Bluetooth Low Energy bridge for Plaud Note Pro recorders.
//!
//! The desktop vault talks to a Plaud recorder over a small JSON-lines protocol
//! on stdin/stdout.  This binary implements that protocol on top of `btleplug`
//! so the vault can talk to a recorder on Linux (BlueZ), Windows (WinRT) and
//! macOS (CoreBluetooth) with the same code.
//!
//! Two sub-commands are supported:
//!
//! * `plaud-bridge scan` — scan for an advertising Plaud recorder and print a
//!   single `DesktopPlaudProbe` JSON object, then exit.  This mirrors
//!   `scripts/scan-plaud.swift`.
//! * `plaud-bridge connect <identifier>` — connect to a recorder and speak the
//!   JSON-lines bridge protocol until stdin closes or the session ends.  This
//!   mirrors `scripts/plaud-bridge.swift`.
//! * `plaud-bridge doctor` — report the host Bluetooth stack (backend, adapter,
//!   power state) as a single JSON object without scanning.  The vault uses it
//!   to autodetect what this machine can do before offering a transfer.
//!
//! `<identifier>` may be a Bluetooth address (`AA:BB:CC:DD:EE:FF`) or the
//! CoreBluetooth UUID used by the macOS identity file.  When it does not match
//! an address seen during the scan the bridge falls back to the first
//! recorder-like peripheral it can see, which keeps a single identity file
//! portable across operating systems.

use std::io::Write;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use btleplug::api::{
    Central, CentralState, CharPropFlags, Manager as _, Peripheral as _, PeripheralProperties,
    ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::stream::StreamExt;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::{Pkcs1v15Encrypt, RsaPrivateKey};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use uuid::Uuid;

/// Plaud GATT service exposed by the recorder command channel.
const SERVICE_UUID: Uuid = Uuid::from_u128(0x00001910_0000_1000_8000_00805f9b34fb);
/// Notify characteristic carrying recorder responses.
const NOTIFY_UUID: Uuid = Uuid::from_u128(0x00002bb0_0000_1000_8000_00805f9b34fb);
/// Write characteristic carrying vault commands.
const WRITE_UUID: Uuid = Uuid::from_u128(0x00002bb1_0000_1000_8000_00805f9b34fb);
/// Advertised name fragment used to recognise a recorder.
const NAME_HINT: &str = "plaud";

/// The GATT command channel of one kind of recorder.  The default is the Plaud
/// Note Pro; `--service/--notify/--write/--name-hint` select another device (for
/// example a paired phone running OpenPlod), so the bridge stays a generic
/// write/notify pipe and each device's protocol lives in the vault.
#[derive(Clone, Debug)]
struct Profile {
    service: Uuid,
    notify: Uuid,
    write: Uuid,
    name_hint: Option<String>,
    /// Only the Plaud profile parses the Note Pro advertisement.
    plaud: bool,
}

impl Profile {
    fn plaud() -> Self {
        Profile { service: SERVICE_UUID, notify: NOTIFY_UUID, write: WRITE_UUID, name_hint: Some(NAME_HINT.to_string()), plaud: true }
    }

    fn label(&self) -> &'static str {
        if self.plaud { "Plaud" } else { "device" }
    }
}

/// Splits `args` (after the mode) into positional values and a device profile.
fn parse_profile(args: &[String]) -> Result<(Vec<String>, Profile), String> {
    let mut profile = Profile::plaud();
    let mut custom = false;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !flag.starts_with("--") {
            positional.push(args[index].clone());
            index += 1;
            continue;
        }
        let value = args.get(index + 1).ok_or_else(|| format!("{flag} needs a value"))?;
        let uuid = || Uuid::parse_str(value).map_err(|_| format!("{flag} is not a UUID"));
        match flag {
            "--service" => profile.service = uuid()?,
            "--notify" => profile.notify = uuid()?,
            "--write" => profile.write = uuid()?,
            "--name-hint" => profile.name_hint = Some(value.to_ascii_lowercase()).filter(|hint| !hint.is_empty()),
            _ => return Err(format!("unknown option {flag}")),
        }
        custom = true;
        index += 2;
    }
    if custom {
        profile.plaud = false;
        if profile.name_hint.as_deref() == Some(NAME_HINT) {
            profile.name_hint = None;
        }
    }
    Ok((positional, profile))
}

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(35);
/// A cold BlueZ cache makes the first connect-and-discover of an unbonded
/// recorder far slower than a warm one, so the probe allows the same budget the
/// connect path does.  Anything tighter reports a healthy recorder as
/// unreachable on the first scan after boot.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_DEADLINE: Duration = Duration::from_secs(600);
const SCAN_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REQUEST_BYTES: usize = 16 * 1024;

type Emitter = mpsc::UnboundedSender<Value>;

fn emit(tx: &Emitter, value: Value) {
    let _ = tx.send(value);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("plaud-bridge: could not start runtime: {error}");
            std::process::exit(1);
        }
    };
    let (positional, profile) = match parse_profile(args.get(2..).unwrap_or(&[])) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("plaud-bridge: {error}");
            std::process::exit(2);
        }
    };
    let result = match mode {
        "doctor" => runtime.block_on(run_doctor()),
        "scan" => runtime.block_on(run_scan(&profile)),
        "connect" => {
            let identifier = positional.first().cloned().unwrap_or_default();
            runtime.block_on(run_connect(identifier, &profile))
        }
        _ => {
            eprintln!("usage: plaud-bridge <doctor|scan|connect> [identifier] [--service UUID --notify UUID --write UUID --name-hint NAME]");
            std::process::exit(2);
        }
    };
    if let Err(error) = result {
        eprintln!("plaud-bridge: {error}");
        std::process::exit(1);
    }
}

async fn adapter() -> Result<Adapter, String> {
    let manager = Manager::new()
        .await
        .map_err(|error| format!("Bluetooth is unavailable: {error}"))?;
    let adapters = manager
        .adapters()
        .await
        .map_err(|error| format!("Bluetooth is unavailable: {error}"))?;
    adapters
        .into_iter()
        .next()
        .ok_or_else(|| "No Bluetooth adapter was found".to_string())
}

fn normalize_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn matches_profile(properties: &PeripheralProperties, profile: &Profile) -> bool {
    let named = match (&profile.name_hint, properties.local_name.as_deref()) {
        (Some(hint), Some(name)) => name.to_ascii_lowercase().contains(hint.as_str()),
        _ => false,
    };
    let advertised = properties.services.contains(&profile.service);
    named || advertised
}

/// Find a recorder, preferring an exact address match but falling back to the
/// first recorder-like peripheral so identities stay portable across platforms.
async fn find_peripheral(
    adapter: &Adapter,
    identifier: &str,
    timeout: Duration,
    profile: &Profile,
) -> Result<Option<Peripheral>, String> {
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|error| format!("Bluetooth scan could not start: {error}"))?;
    let target = normalize_identifier(identifier);
    let deadline = Instant::now() + timeout;
    let mut fallback: Option<Peripheral> = None;
    let mut exact: Option<Peripheral> = None;
    'outer: loop {
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let peripherals = adapter
            .peripherals()
            .await
            .map_err(|error| format!("Bluetooth scan failed: {error}"))?;
        for peripheral in peripherals {
            if !target.is_empty()
                && normalize_identifier(&peripheral.address().to_string()) == target
            {
                exact = Some(peripheral);
                break 'outer;
            }
            if fallback.is_none() {
                if let Some(properties) = peripheral.properties().await.ok().flatten() {
                    if matches_profile(&properties, profile) {
                        fallback = Some(peripheral);
                    }
                }
            }
        }
        if fallback.is_some() {
            break;
        }
    }
    let _ = adapter.stop_scan().await;
    Ok(exact.or(fallback))
}

/// The Bluetooth backend `btleplug` binds to on this target.  Reported so the
/// vault can name the host stack in diagnostics instead of guessing from the
/// operating system.
const fn backend() -> &'static str {
    if cfg!(target_os = "macos") {
        "corebluetooth"
    } else if cfg!(target_os = "windows") {
        "winrt"
    } else {
        "bluez"
    }
}

/// Report the host Bluetooth stack without scanning.  Always exits 0: an
/// unusable adapter is a diagnosis, not a crash, and the vault renders it.
async fn run_doctor() -> Result<(), String> {
    let report = match adapter().await {
        Err(error) => json!({
            "backend": backend(),
            "adapterAvailable": false,
            "poweredOn": false,
            "adapter": null,
            "detail": error,
        }),
        Ok(adapter) => {
            let name = adapter.adapter_info().await.ok();
            let state = adapter.adapter_state().await.ok();
            let powered = matches!(state, Some(CentralState::PoweredOn));
            // A present-but-unpowered adapter is the common Linux case (rfkill
            // soft block), so it gets its own actionable message.
            let detail = match state {
                Some(CentralState::PoweredOn) => "Bluetooth adapter is available and powered on.",
                Some(CentralState::PoweredOff) => {
                    "Bluetooth adapter is powered off. Turn Bluetooth on and retry."
                }
                _ => "Bluetooth adapter state is unknown. Turn Bluetooth on and retry.",
            };
            json!({
                "backend": backend(),
                "adapterAvailable": true,
                "poweredOn": powered,
                "adapter": name,
                "detail": detail,
            })
        }
    };
    println!("{report}");
    let _ = std::io::stdout().flush();
    Ok(())
}

async fn run_scan(profile: &Profile) -> Result<(), String> {
    let adapter = adapter().await?;
    let found = find_peripheral(&adapter, "", SCAN_TIMEOUT, profile).await?;
    let probe = match found {
        None => json!({
            "detected": false,
            "name": null,
            "identifier": null,
            "serial": null,
            "protocolVersion": null,
            "rssi": null,
            "manufacturerData": [],
            "connectionVerified": false,
            "detail": if profile.plaud {
                "No advertising Plaud found. Wake the device and keep it near this computer."
            } else {
                "No advertising device found. Open the app on the device and keep it near this computer."
            },
        }),
        Some(peripheral) => {
            let address = peripheral.address().to_string();
            let properties = peripheral.properties().await.ok().flatten();
            let name = properties
                .as_ref()
                .and_then(|properties| properties.local_name.clone())
                .unwrap_or_else(|| profile.label().to_string());
            let rssi = properties.as_ref().and_then(|properties| properties.rssi);
            // Company-id keyed manufacturer payloads.  `btleplug` strips the
            // two company-identifier bytes that CoreBluetooth keeps, so they are
            // restored here: the vault then parses one identical layout on every
            // platform (`parseNoteProAdvertisement`).
            let manufacturer_data: Vec<Value> = properties
                .as_ref()
                .map(|properties| {
                    properties
                        .manufacturer_data
                        .iter()
                        .map(|(company, bytes)| {
                            let mut framed = Vec::with_capacity(bytes.len() + 2);
                            framed.extend_from_slice(&company.to_le_bytes());
                            framed.extend_from_slice(bytes);
                            json!({ "companyId": company, "data": BASE64.encode(framed) })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let (serial, protocol_version) = if profile.plaud {
                parse_note_pro_advertisement(&manufacturer_data)
            } else {
                (None, None)
            };
            let verified = verify_connection(&peripheral, profile).await;
            let _ = peripheral.disconnect().await;
            json!({
                "detected": true,
                "name": name,
                "identifier": address,
                "serial": serial,
                "protocolVersion": protocol_version,
                "rssi": rssi,
                "manufacturerData": manufacturer_data,
                "connectionVerified": verified,
                "detail": match (verified, profile.plaud) {
                    (true, _) => "Bluetooth connection verified. Recording access is not authenticated.",
                    (false, true) => "Plaud detected, but the Bluetooth connection failed. Retry with other Plaud clients disconnected.",
                    (false, false) => "Device detected, but the Bluetooth connection failed. Keep the app open on the device and retry.",
                },
            })
        }
    };
    println!("{probe}");
    let _ = std::io::stdout().flush();
    Ok(())
}

/// Best-effort decode of the Plaud Note Pro advertisement payload.
///
/// Mirrors `parseNoteProAdvertisement` in `src/sync/plaud-protocol.ts`: the
/// serial lives at bytes 11..19 and the protocol version at byte 20.
fn parse_note_pro_advertisement(manufacturer_data: &[Value]) -> (Option<String>, Option<u16>) {
    for entry in manufacturer_data {
        let Some(encoded) = entry.get("data").and_then(Value::as_str) else {
            continue;
        };
        let Ok(bytes) = BASE64.decode(encoded) else {
            continue;
        };
        if bytes.len() < 22 || bytes[2] != 2 || bytes[5] != 4 || bytes[10] != 8 {
            continue;
        }
        let project = u16::from_le_bytes([bytes[3], bytes[4]]);
        if project != 881 && project != 883 {
            continue;
        }
        let serial = bytes[11..19]
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        let protocol_version = u16::from_le_bytes([bytes[20], bytes[21]]);
        return (Some(serial), Some(protocol_version));
    }
    (None, None)
}

async fn verify_connection(peripheral: &Peripheral, profile: &Profile) -> bool {
    if !matches!(
        tokio::time::timeout(VERIFY_TIMEOUT, peripheral.connect()).await,
        Ok(Ok(()))
    ) {
        return false;
    }
    if !matches!(
        tokio::time::timeout(VERIFY_TIMEOUT, peripheral.discover_services()).await,
        Ok(Ok(()))
    ) {
        return false;
    }
    peripheral
        .services()
        .iter()
        .any(|service| service.uuid == profile.service)
}

async fn run_connect(identifier: String, profile: &Profile) -> Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        while let Some(value) = rx.recv().await {
            let stdout = std::io::stdout();
            let mut out = stdout.lock();
            if serde_json::to_writer(&mut out, &value).is_ok() {
                let _ = out.write_all(b"\n");
                let _ = out.flush();
            }
        }
    });

    let adapter = adapter().await?;
    let peripheral = find_peripheral(&adapter, &identifier, SCAN_TIMEOUT, profile)
        .await?
        .ok_or_else(|| "connection_timeout".to_string())?;

    if !matches!(
        tokio::time::timeout(DISCOVERY_TIMEOUT, peripheral.connect()).await,
        Ok(Ok(()))
    ) {
        emit(&tx, json!({ "event": "closed", "reason": "connection_failed" }));
        return Ok(());
    }
    emit(&tx, json!({ "event": "connected" }));

    if !matches!(
        tokio::time::timeout(DISCOVERY_TIMEOUT, peripheral.discover_services()).await,
        Ok(Ok(()))
    ) {
        emit(&tx, json!({ "event": "closed", "reason": "characteristic_discovery_failed" }));
        return Ok(());
    }

    let characteristics = peripheral.characteristics();
    if !peripheral
        .services()
        .iter()
        .any(|service| service.uuid == profile.service)
    {
        emit(&tx, json!({ "event": "closed", "reason": "missing_command_service" }));
        return Ok(());
    }
    let notify_uuid = profile.notify;
    let notify = characteristics
        .iter()
        .find(|characteristic| characteristic.uuid == notify_uuid)
        .cloned();
    let writer = characteristics
        .iter()
        .find(|characteristic| characteristic.uuid == profile.write)
        .cloned();
    let (Some(notify), Some(writer)) = (notify, writer) else {
        emit(&tx, json!({ "event": "closed", "reason": "missing_command_characteristics" }));
        return Ok(());
    };

    if peripheral.subscribe(&notify).await.is_err() {
        emit(&tx, json!({ "event": "closed", "reason": "subscription_failed" }));
        return Ok(());
    }

    // Drain notifications on their own task so commands never block on them.
    match peripheral.notifications().await {
        Ok(mut notifications) => {
            let tx = tx.clone();
            tokio::spawn(async move {
                while let Some(notification) = notifications.next().await {
                    let is_packet = notification.uuid == notify_uuid;
                    emit(
                        &tx,
                        json!({
                            "event": if is_packet { "packet" } else { "metadata" },
                            "uuid": notification.uuid.to_string().to_ascii_uppercase(),
                            "data": BASE64.encode(&notification.value),
                        }),
                    );
                }
            });
        }
        Err(_) => {
            emit(&tx, json!({ "event": "closed", "reason": "notification_failed" }));
            return Ok(());
        }
    }

    // Publish any readable characteristics as metadata, mirroring the macOS bridge.
    for characteristic in characteristics
        .iter()
        .filter(|characteristic| characteristic.properties.contains(CharPropFlags::READ))
    {
        if let Ok(Ok(value)) =
            tokio::time::timeout(Duration::from_secs(5), peripheral.read(characteristic)).await
        {
            emit(
                &tx,
                json!({
                    "event": "metadata",
                    "uuid": characteristic.uuid.to_string().to_ascii_uppercase(),
                    "data": BASE64.encode(value),
                }),
            );
        }
    }

    emit(&tx, json!({ "event": "ready", "maxWrite": 512 }));

    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut health = tokio::time::interval(Duration::from_secs(2));
    health.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let deadline = tokio::time::sleep(SESSION_DEADLINE);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                emit(&tx, json!({ "event": "closed", "reason": "session_deadline" }));
                break;
            }
            _ = health.tick() => {
                if !peripheral.is_connected().await.unwrap_or(false) {
                    emit(&tx, json!({ "event": "closed", "reason": "disconnected" }));
                    break;
                }
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(text)) => {
                        if !handle_request(&text, &tx, &peripheral, &writer).await {
                            break;
                        }
                    }
                    _ => {
                        emit(&tx, json!({ "event": "closed", "reason": "client_eof" }));
                        break;
                    }
                }
            }
        }
    }

    let _ = peripheral.disconnect().await;
    Ok(())
}

/// Handle one JSON-lines request.  Returns `false` when the session should end.
async fn handle_request(
    text: &str,
    tx: &Emitter,
    peripheral: &Peripheral,
    writer: &btleplug::api::Characteristic,
) -> bool {
    if text.len() > MAX_REQUEST_BYTES {
        emit(tx, json!({ "event": "closed", "reason": "invalid_request" }));
        return false;
    }
    let Ok(request) = serde_json::from_str::<Value>(text) else {
        emit(tx, json!({ "event": "closed", "reason": "invalid_request" }));
        return false;
    };
    let id = request.get("id").and_then(Value::as_i64).unwrap_or(-1);
    match request.get("op").and_then(Value::as_str) {
        Some("write") => {
            let data = request
                .get("data")
                .and_then(Value::as_str)
                .and_then(|value| BASE64.decode(value).ok());
            let ok = match data {
                Some(bytes) if !bytes.is_empty() => peripheral
                    .write(writer, &bytes, WriteType::WithResponse)
                    .await
                    .is_ok(),
                _ => false,
            };
            emit(tx, json!({ "event": "reply", "id": id, "ok": ok }));
        }
        Some("rsa-decrypt") => {
            let key = request
                .get("key")
                .and_then(Value::as_str)
                .and_then(|value| BASE64.decode(value).ok());
            let ciphertext = request
                .get("data")
                .and_then(Value::as_str)
                .and_then(|value| BASE64.decode(value).ok());
            let plaintext = match (key, ciphertext) {
                (Some(key), Some(ciphertext)) if ciphertext.len() == 256 => decode_private_key(&key)
                    .and_then(|private| {
                        private
                            .decrypt(Pkcs1v15Encrypt, &ciphertext)
                            .map_err(|_| "decrypt failed".to_string())
                    })
                    .ok(),
                _ => None,
            };
            match plaintext {
                Some(plaintext) => emit(
                    tx,
                    json!({ "event": "reply", "id": id, "ok": true, "data": BASE64.encode(plaintext) }),
                ),
                None => emit(tx, json!({ "event": "reply", "id": id, "ok": false })),
            }
        }
        Some("close") => {
            emit(tx, json!({ "event": "closed", "reason": "client_closed" }));
            return false;
        }
        _ => emit(tx, json!({ "event": "reply", "id": id, "ok": false })),
    }
    true
}

fn decode_private_key(bytes: &[u8]) -> Result<RsaPrivateKey, String> {
    RsaPrivateKey::from_pkcs1_der(bytes)
        .or_else(|_| RsaPrivateKey::from_pkcs8_der(bytes))
        .map_err(|_| "invalid RSA private key".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn default_profile_is_plaud() {
        let (positional, profile) = parse_profile(&strings(&["AA:BB:CC:DD:EE:FF"])).unwrap();
        assert_eq!(positional, vec!["AA:BB:CC:DD:EE:FF"]);
        assert!(profile.plaud);
        assert_eq!(profile.service, SERVICE_UUID);
    }

    #[test]
    fn custom_profile_replaces_uuids_and_drops_the_plaud_name_hint() {
        let (positional, profile) = parse_profile(&strings(&[
            "--service", "7f1e0001-5c6a-4b8e-9d1a-0a9e0f9c4f10",
            "--notify", "7f1e0002-5c6a-4b8e-9d1a-0a9e0f9c4f10",
            "--write", "7f1e0003-5c6a-4b8e-9d1a-0a9e0f9c4f10",
            "11:22:33:44:55:66",
        ]))
        .unwrap();
        assert_eq!(positional, vec!["11:22:33:44:55:66"]);
        assert!(!profile.plaud);
        assert_eq!(profile.name_hint, None);
        assert_eq!(profile.write.to_string(), "7f1e0003-5c6a-4b8e-9d1a-0a9e0f9c4f10");
    }

    #[test]
    fn bad_options_are_rejected() {
        assert!(parse_profile(&strings(&["--service"])).is_err());
        assert!(parse_profile(&strings(&["--service", "not-a-uuid"])).is_err());
        assert!(parse_profile(&strings(&["--colour", "blue"])).is_err());
    }
}
