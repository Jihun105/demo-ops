import UIKit
import Capacitor

class DemoBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DemoSessionPlugin())
        bridge?.registerPluginInstance(DemoMessagesPlugin())
        bridge?.registerPluginInstance(DemoEarthPlugin())
        bridge?.registerPluginInstance(DemoMapPlugin())
    }
}
