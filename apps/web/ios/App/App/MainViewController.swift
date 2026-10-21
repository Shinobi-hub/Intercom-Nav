import Capacitor
import UIKit

/// The app's bridge view controller. Plugins that live in this app target (not in npm packages)
/// aren't discovered automatically, so they are registered here.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RideServicePlugin())
        // Vendored @capacitor-community/background-geolocation; see BackgroundGeolocationPlugin.swift.
        bridge?.registerPluginInstance(BackgroundGeolocation())
    }
}
