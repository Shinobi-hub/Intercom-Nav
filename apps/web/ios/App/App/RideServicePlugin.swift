import AVFoundation
import Capacitor
import CoreLocation
import UIKit
import UserNotifications

/// iOS side of the RideService plugin (JS binding: src/platform/native/plugins.ts).
///
/// iOS has no foreground service: background GPS and voice come from UIBackgroundModes
/// `location` + `audio` (Info.plist) while location updates run and the audio session is active.
/// This plugin owns the AVAudioSession configuration for the ride:
///   play-and-record: .playAndRecord with Bluetooth HFP (helmet mic), A2DP, speaker instead of the
///                    earpiece, and mixing, so other apps' audio (navigation prompts, a music app)
///                    neither interrupts the intercom nor gets cut off by it;
///   playback:        .playback with mixing, used while the mic is off so the headset can stay on A2DP;
///   auto:            leaves the category to WebKit.
/// The configuration is re-applied after interruptions (calls, Siri) and media-services resets.
/// WebKit may change the category itself when capture starts or stops; whether this survives that
/// in a WKWebView with the screen locked must be verified on a device (docs/NATIVE.md).
@objc(RideServicePlugin)
public class RideServicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RideServicePlugin"
    public let jsName = "RideService"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ensurePermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPermissionStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBluetoothRouting", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAudioMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)
    ]

    private enum AudioMode: String {
        case auto
        case playback
        case playAndRecord = "play-and-record"
    }

    private var running = false
    /// Last mode JS asked for; nil until it asks.
    private var mode: AudioMode?

    override public func load() {
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        center.addObserver(self, selector: #selector(onInterruption(_:)), name: AVAudioSession.interruptionNotification, object: session)
        center.addObserver(self, selector: #selector(onMediaServicesReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: session)
        center.addObserver(self, selector: #selector(onRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: session)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Ride

    @objc func start(_ call: CAPPluginCall) {
        running = true
        // A ride is a voice call: until JS picks a mode, record + play with Bluetooth.
        do {
            try apply(mode ?? .playAndRecord)
        } catch {
            CAPLog.print("⚡️ RideService: audio session setup failed: \(error.localizedDescription)")
        }
        call.resolve(status())
    }

    @objc func stop(_ call: CAPPluginCall) {
        running = false
        // Let other apps' audio come back to full volume.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        call.resolve()
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(status())
    }

    @objc func setAudioMode(_ call: CAPPluginCall) {
        guard let raw = call.getString("mode"), let requested = AudioMode(rawValue: raw) else {
            call.reject("mode must be auto, playback or play-and-record")
            return
        }
        mode = requested
        do {
            try apply(requested)
            call.resolve()
        } catch {
            call.reject("Audio session: \(error.localizedDescription)", nil, error)
        }
    }

    /// Routing follows the category options on iOS; this only reports the current route.
    @objc func setBluetoothRouting(_ call: CAPPluginCall) {
        call.resolve(routeInfo())
    }

    private func apply(_ mode: AudioMode) throws {
        let session = AVAudioSession.sharedInstance()
        switch mode {
        case .auto:
            return
        case .playAndRecord:
            // .default mode, not .voiceChat: WebRTC does its own echo cancellation, and voiceChat
            // would also rule out A2DP. (.allowBluetooth is renamed .allowBluetoothHFP in the iOS 26
            // SDK; the old name still compiles with a deprecation warning.)
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
            )
        case .playback:
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        }
        try session.setActive(true)
    }

    private func reapply(reason: String) {
        guard running else { return }
        do {
            try apply(mode ?? .playAndRecord)
        } catch {
            CAPLog.print("⚡️ RideService: re-applying audio session after \(reason) failed: \(error.localizedDescription)")
        }
    }

    @objc private func onInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw), type == .ended else { return }
        // A phone call or Siri ended: get the intercom back without waiting for a tap.
        reapply(reason: "interruption")
    }

    @objc private func onMediaServicesReset(_ note: Notification) {
        reapply(reason: "media services reset")
    }

    @objc private func onRouteChange(_ note: Notification) {
        notifyListeners("audioRoute", data: routeInfo())
    }

    private func routeInfo() -> [String: Any] {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let bluetoothPorts: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothA2DP, .bluetoothLE]
        let bluetooth = outputs.first { bluetoothPorts.contains($0.portType) }
        return [
            "enabled": true,
            "bluetoothAvailable": bluetooth != nil,
            "bluetoothActive": bluetooth != nil,
            "device": (bluetooth ?? outputs.first)?.portName as Any,
            "mode": AVAudioSession.sharedInstance().category.rawValue
        ]
    }

    private func status() -> [String: Any] {
        return ["running": running, "keepAlive": false, "types": [String](), "route": routeInfo()]
    }

    // MARK: - Permissions (reported only: iOS prompts from getUserMedia, CLLocationManager and
    // UNUserNotificationCenter themselves, one at a time)

    @objc func ensurePermissions(_ call: CAPPluginCall) {
        permissionStatus { call.resolve($0) }
    }

    @objc func getPermissionStatus(_ call: CAPPluginCall) {
        permissionStatus { call.resolve($0) }
    }

    private func permissionStatus(_ done: @escaping ([String: Any]) -> Void) {
        let location: String
        var precise = false
        let manager = CLLocationManager()
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            location = "granted"
            precise = manager.accuracyAuthorization == .fullAccuracy
        case .denied, .restricted:
            location = "denied"
        default:
            location = "prompt"
        }
        let microphone: String
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: microphone = "granted"
        case .denied: microphone = "denied"
        default: microphone = "prompt"
        }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let notifications: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: notifications = "granted"
            case .denied: notifications = "denied"
            default: notifications = "prompt"
            }
            done([
                "location": location,
                "preciseLocation": precise,
                "microphone": microphone,
                "notifications": notifications,
                "bluetooth": "granted"
            ])
        }
    }

    // MARK: - Open URL / share

    @objc func openUrl(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            call.reject("url is required")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                ok ? call.resolve() : call.reject("No app can open \(raw)", "NO_HANDLER")
            }
        }
    }

    @objc func share(_ call: CAPPluginCall) {
        var items: [Any] = []
        if let text = call.getString("text"), !text.isEmpty { items.append(text) }
        if let raw = call.getString("url"), let url = URL(string: raw) { items.append(url) }
        if items.isEmpty, let title = call.getString("title") { items.append(title) }
        guard !items.isEmpty else {
            call.reject("Nothing to share")
            return
        }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("No view controller to present from")
                return
            }
            let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let subject = call.getString("title") { sheet.setValue(subject, forKey: "subject") }
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                call.resolve(["completed": completed])
            }
            // iPad presents the sheet as a popover, which needs an anchor.
            if let popover = sheet.popoverPresentationController, let view = presenter.view {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true)
        }
    }
}
