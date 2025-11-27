/**
 * Remote Pairing Module
 *
 * Provides functionality for iOS remote pairing over WiFi.
 * Includes storage for pairing records and the tunnel service
 * for establishing WiFi connections to paired devices.
 */

export {
  RemotePairingStorage,
  getRemotePairingStorage,
  type RemotePairingRecord,
} from './remote-pairing-storage.js';

export {
  RemotePairingTunnelService,
  type RemotePairingTunnelResult,
  type ListenerResult,
} from './remote-pairing-tunnel-service.js';

export {
  WiFiDeviceDiscovery,
  getWiFiDeviceDiscovery,
  type WiFiDevice,
} from './wifi-device-discovery.js';

