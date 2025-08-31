/**
 * Common type definitions for the appium-ios-remotexpc library
 */
import type { PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'events';

import type { ServiceConnection } from '../service-connection.js';
import type { BaseService, Service } from '../services/ios/base-service.js';
import type { RemoteXpcConnection } from './remote-xpc/remote-xpc-connection.js';
import type { Device } from './usbmux/index.js';

/**
 * Represents a value that can be stored in a plist
 */
export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | PlistArray
  | PlistDictionary
  | null;

/**
 * Represents an array in a plist
 */
export type PlistArray = Array<PlistValue>;

/**
 * Represents a dictionary in a plist
 */
export interface PlistDictionary {
  [key: string]: PlistValue;
}

/**
 * Represents a message that can be sent or received via plist
 */
export type PlistMessage = PlistDictionary;

/**
 * Represents a value that can be encoded in XPC protocol
 */
export type XPCValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | Uint8Array
  | XPCArray
  | XPCDictionary
  | null;

/**
 * Represents an array in XPC protocol
 */
export type XPCArray = Array<XPCValue>;

/**
 * Represents a dictionary in XPC protocol
 */
export interface XPCDictionary {
  [key: string]: XPCValue;
}

/**
 * Represents a callback function for handling responses
 */
export type ResponseCallback<T> = (data: T) => void;

export interface TunnelRegistryEntry {
  /** Unique device identifier */
  udid: string;
  /** Numeric device ID */
  deviceId: number;
  /** IP address of the tunnel */
  address: string;
  /** Remote Service Discovery (RSD) port number */
  rsdPort: number;
  /** Packet stream port number */
  packetStreamPort: number;
  /** Type of connection (e.g., 'USB', 'Network') */
  connectionType: string;
  /** Product identifier of the device */
  productId: number;
  /** Timestamp when the tunnel was created (milliseconds since epoch) */
  createdAt: number;
  /** Timestamp when the tunnel was last updated (milliseconds since epoch) */
  lastUpdated: number;
}

export interface TunnelRegistry {
  /** Map of UDID to tunnel registry entries */
  tunnels: Record<string, TunnelRegistryEntry>;
  /** Metadata about the registry */
  metadata: {
    /** ISO 8601 timestamp of last registry update */
    lastUpdated: string;
    /** Total number of tunnels in the registry */
    totalTunnels: number;
    /** Number of currently active tunnels */
    activeTunnels: number;
  };
}

export interface SocketInfo {
  /** Device server information */
  server: Device;
  /** Port number for the socket connection */
  port: number;
  /** Device-specific information */
  deviceInfo: {
    /** Unique device identifier */
    udid: string;
    /** IP address of the device */
    address: string;
    /** Optional Remote Service Discovery (RSD) port number */
    rsdPort?: number;
  };
}

export interface TunnelResult {
  /** Device information */
  device: Device;
  /** Tunnel connection details */
  tunnel: {
    /** IP address of the tunnel */
    Address: string;
    /** Optional Remote Service Discovery (RSD) port number */
    RsdPort?: number;
  };
  /** Optional packet stream port number */
  packetStreamPort?: number;
  /** Indicates whether the tunnel creation was successful */
  success: boolean;
  /** Error message if tunnel creation failed */
  error?: string;
}

/**
 * Represents the instance side of DiagnosticsService
 */
export interface DiagnosticsService extends BaseService {
  /**
   * Restart the device
   * @returns Promise that resolves when the restart request is sent
   */
  restart(): Promise<PlistDictionary>;

  /**
   * Shutdown the device
   * @returns Promise that resolves when the shutdown request is sent
   */
  shutdown(): Promise<PlistDictionary>;

  /**
   * Put the device in sleep mode
   * @returns Promise that resolves when the sleep request is sent
   */
  sleep(): Promise<PlistDictionary>;

  /**
   * Query IORegistry
   * @param options Options for the IORegistry query
   * @returns Object containing the IORegistry information
   */
  ioregistry(options?: {
    plane?: string;
    name?: string;
    ioClass?: string;
    returnRawJson?: boolean;
    timeout?: number;
  }): Promise<PlistDictionary[] | Record<string, any>>;
}

/**
 * Represents the static side of DiagnosticsService
 */
export interface NotificationProxyService extends BaseService {
  /**
   * Connect to the notification proxy service
   * @returns Promise resolving to the ServiceConnection instance
   */
  connectToNotificationProxyService(): Promise<ServiceConnection>;
  /**
   * Observe a notification
   * @param notification The notification name to subscribe to
   * @returns Promise that resolves when the subscription request is sent
   */
  observe(notification: string): Promise<PlistDictionary>;
  /**
   * Post a notification
   * @param notification The notification name to post
   * @returns Promise that resolves when the post request is sent
   */
  post(notification: string): Promise<PlistDictionary>;
  /**
   * Expect notifications as an async generator
   * @param timeout Timeout in milliseconds
   * @returns AsyncGenerator yielding PlistMessage objects
   */
  expectNotifications(timeout?: number): AsyncGenerator<PlistMessage>;
  /**
   * Expect a single notification
   * @param timeout Timeout in milliseconds
   * @returns Promise resolving to the expected notification
   */
  expectNotification(timeout?: number): Promise<PlistMessage>;
}

/**
 * Represents the HeartbeatService interface for connection keep-alive
 */
export interface HeartbeatService extends BaseService {
  /**
   * Start the heartbeat service and establish connection
   * Follows Python implementation: recv_plist() -> send_plist({'Command': 'Polo'}) loop
   * @param interval Optional interval in seconds to stop after
   * @param blocking If true, blocks until service stops (Python behavior). If false, starts and returns immediately.
   * @returns Promise that resolves when the service stops (if blocking) or when service starts (if non-blocking)
   */
  start(interval?: number, blocking?: boolean): Promise<void>;
  /**
   * Stop the heartbeat service
   * @returns Promise that resolves when the service is stopped
   */
  stop(): Promise<void>;
  /**
   * Send a Polo response (matches Python: service.send_plist({'Command': 'Polo'}))
   * @returns Promise that resolves when the Polo response is sent
   */
  sendPolo(): Promise<void>;
  /**
   * Check if the heartbeat service is running
   * @returns Boolean indicating if the service is active
   */
  isRunning(): boolean;
  /**
   * Connect to the heartbeat service
   * @returns Promise resolving to the ServiceConnection instance
   */
  connectToHeartbeatService(): Promise<ServiceConnection>;
}

/**
 * Represents the static side of DiagnosticsService
 */
export interface DiagnosticsServiceConstructor {
  /**
   * Service name for Remote Service Discovery
   */
  readonly RSD_SERVICE_NAME: string;
  /**
   * Creates a new DiagnosticsService instance
   * @param address Tuple containing [host, port]
   */
  new (address: [string, number]): DiagnosticsService;
}

/**
 * Represents a DiagnosticsService instance with its associated RemoteXPC connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface DiagnosticsServiceWithConnection {
  /** The DiagnosticsService instance */
  diagnosticsService: DiagnosticsService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Represents a NotificationProxyService instance with its associated RemoteXPC connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface NotificationProxyServiceWithConnection {
  /** The NotificationProxyService instance */
  notificationProxyService: NotificationProxyService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Represents a HeartbeatService instance with its associated RemoteXPC connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface HeartbeatServiceWithConnection {
  /** The HeartbeatService instance */
  heartbeatService: HeartbeatService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Options for configuring syslog capture
 */
export interface SyslogOptions {
  /** Process ID to filter logs by */
  pid?: number;
  /** Whether to enable verbose logging */
  enableVerboseLogging?: boolean;
}

/**
 * Interface for a packet source that can provide packet data
 */
export interface PacketSource {
  /** Add a packet consumer to receive packets */
  addPacketConsumer: (consumer: PacketConsumer) => void;
  /** Remove a packet consumer */
  removePacketConsumer: (consumer: PacketConsumer) => void;
}

/**
 * Interface for a packet consumer that can process packets
 */
export interface PacketConsumer {
  /** Handler for received packets */
  onPacket: (packet: PacketData) => void;
}

/**
 * Represents the instance side of SyslogService
 */
export interface SyslogService extends EventEmitter {
  /**
   * Starts capturing syslog data from the device
   * @param service Service information
   * @param packetSource Source of packet data (can be PacketConsumer or AsyncIterable)
   * @param options Configuration options for syslog capture
   * @returns Promise resolving to the initial response from the service
   */
  start(
    service: Service,
    packetSource: PacketSource | AsyncIterable<PacketData>,
    options?: SyslogOptions,
  ): Promise<void>;

  /**
   * Stops capturing syslog data
   * @returns Promise that resolves when capture is stopped
   */
  stop(): Promise<void>;

  /**
   * Restart the device
   * @param service Service information
   * @returns Promise that resolves when the restart request is sent
   */
  restart(service: Service): Promise<void>;

  /**
   * Event emitter for 'start' events
   */
  on(event: 'start', listener: (response: any) => void): this;

  /**
   * Event emitter for 'stop' events
   */
  on(event: 'stop', listener: () => void): this;

  /**
   * Event emitter for 'message' events
   */
  on(event: 'message', listener: (message: string) => void): this;

  /**
   * Event emitter for 'plist' events
   */
  on(event: 'plist', listener: (data: any) => void): this;

  /**
   * Event emitter for 'error' events
   */
  on(event: 'error', listener: (error: Error) => void): this;

  /**
   * Event emitter for any events
   */
  on(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Represents the static side of SyslogService
 */
export interface SyslogServiceConstructor {
  /**
   * Creates a new SyslogService instance
   * @param address Tuple containing [host, port]
   */
  new (address: [string, number]): SyslogService;
}
