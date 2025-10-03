import { logger } from '@appium/support';
import { EventEmitter } from 'events';

import type {
  PlistDictionary,
  PlistMessage,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';
import { PlistService } from '../../../lib/plist/plist-service.js';

const log = logger.getLogger('WebInspectorService');

/**
 * Interface for WebInspector message structure
 */
export interface WebInspectorMessage extends PlistDictionary {
  __selector: string;
  __argument: PlistDictionary;
}

/**
 * WebInspectorService provides an API to:
 * - Send messages to webinspectord
 * - Listen to messages from webinspectord
 * - Communicate with web views and Safari on iOS devices
 *
 * This service is used for web automation, inspection, and debugging.
 */
export class WebInspectorService extends BaseService {
  static readonly RSD_SERVICE_NAME = 'com.apple.webinspector.shim.remote';

  private connection: ServiceConnection | null = null;
  private messageEmitter: EventEmitter = new EventEmitter();
  private isListening: boolean = false;
  private connectionId: string;
  private isFirstMessage: boolean = true;

  // Internal state tracking (like pmd3)
  private connectedApplications: Map<string, any> = new Map();
  private applicationPages: Map<string, Map<number, any>> = new Map();
  private automationAvailability: string = 'WIRAutomationAvailabilityUnknown';

  constructor(address: [string, number]) {
    super(address);
    // Generate a unique connection identifier (uppercase UUID format)
    this.connectionId = this.generateConnectionId();
  }

  /**
   * Generate a unique connection identifier in uppercase UUID format
   * @returns Connection ID string
   */
  private generateConnectionId(): string {
    // Generate UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
      .replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      })
      .toUpperCase();
  }

  /**
   * Connect to the WebInspector service
   * @returns Promise resolving to the ServiceConnection instance
   */
  private async connectToWebInspectorService(): Promise<ServiceConnection> {
    if (this.connection) {
      return this.connection;
    }

    // Enable verbose plist error logging to diagnose any decoder issues
    PlistService.enableVerboseErrorLogging();

    const service = this.getServiceConfig();
    this.connection = await this.startLockdownService(service, {
      plistOptions: { useBinaryEncoding: true },
    });

    // Send initial identifier report and handle StartService response if needed
    await this.reportIdentifier();

    log.debug('Connected to WebInspector service');
    return this.connection;
  }

  /**
   * Get the service configuration
   * @returns Service configuration object
   */
  private getServiceConfig() {
    return {
      serviceName: WebInspectorService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };
  }

  /**
   * Report identifier to the WebInspector service
   * This is the initial handshake message
   */
  private async reportIdentifier(): Promise<void> {
    const isNewConnection = this.isFirstMessage;

    if (!isNewConnection || !this.connection) {
      return;
    }

    // Build the identifier message
    const message: WebInspectorMessage = {
      __selector: '_rpc_reportIdentifier:',
      __argument: {
        WIRConnectionIdentifierKey: this.connectionId,
      },
    };

    log.debug('Sending _rpc_reportIdentifier: message');
    log.debug(`Full message to send: ${JSON.stringify(message, null, 2)}`);

    try {
      // Send the identifier message
      this.connection.sendPlist(message);
      log.debug('_rpc_reportIdentifier: sent successfully');

      // Like pmd3, wait for and handle the FIRST WebInspector message before starting background task.
      // Drain any 'StartService' frames and ignore non-inspector frames until we get a __selector or time out.
      try {
        const timeoutMs = 5000;
        const startTs = Date.now();
        let handledFirst = false;

        while (Date.now() - startTs < timeoutMs) {
          const remaining = Math.max(1, timeoutMs - (Date.now() - startTs));
          const response = await this.connection.receivePlist(remaining);
          log.debug(`Initial WebInspector receive: ${JSON.stringify(response, null, 2)}`);

          // Skip any StartService frames that may arrive late from RSD check-in
          if (response && typeof response === 'object' && (response as any).Request === 'StartService') {
            log.debug('Drained StartService during handshake, continuing to wait for __selector message...');
            continue;
          }

          // Handle first valid inspector message
          if (response && typeof response === 'object' && (response as any).__selector) {
            log.debug(`Handling initial inspector message with selector: ${(response as any).__selector}`);
            this.handleIncomingMessage(response);
            handledFirst = true;
            break;
          }

          // If it's neither StartService nor an inspector message, just log and continue
          log.debug('Ignoring non-inspector preface frame during handshake (no __selector, not StartService)');
        }

        if (!handledFirst) {
          log.warn('Did not receive initial WebInspector __selector message within handshake timeout');
        }
      } catch (receiveError) {
        // Like pmd3, timeout here likely means WebInspector is not enabled
        log.error(`No response from WebInspector service: ${(receiveError as Error).message}`);
        log.error('This usually means WebInspector is not enabled on the device.');
        log.error('To enable: Settings → Safari → Advanced → Web Inspector (turn ON)');
        // Don't throw - allow service to continue but it won't receive messages
      }

      this.isFirstMessage = false;
      log.debug('WebInspector service initialized');

      // Now start background message receiver (like pmd3's create_task)
      this.startBackgroundReceiver();
    } catch (error) {
      log.error('Failed to send _rpc_reportIdentifier:', (error as Error).message);
      throw new Error(`WebInspector connection failed: ${(error as Error).message}`);
    }
  }

  /**
   * Handle incoming WebInspector messages (like pmd3's _handle_recv)
   */
  private handleIncomingMessage(plist: any): void {
    if (!plist || typeof plist !== 'object') {
      return;
    }

    const selector = plist.__selector;
    const argument = plist.__argument || {};

    log.debug(`Handling selector: ${selector}`);

    switch (selector) {
      case '_rpc_reportCurrentState:':
        this.handleReportCurrentState(argument);
        break;
      case '_rpc_reportConnectedApplicationList:':
        this.handleReportConnectedApplicationList(argument);
        break;
      case '_rpc_reportConnectedDriverList:':
        // Present in pymobiledevice3; we don't use it currently, but log for visibility
        log.debug('Received _rpc_reportConnectedDriverList: (ignored)');
        break;
      case '_rpc_applicationUpdated:':
        this.handleApplicationUpdated(argument);
        break;
      case '_rpc_applicationSentListing:':
        this.handleApplicationSentListing(argument);
        break;
      case '_rpc_applicationConnected:':
        this.handleApplicationConnected(argument);
        break;
      case '_rpc_applicationDisconnected:':
        this.handleApplicationDisconnected(argument);
        break;
      case '_rpc_applicationSentData:':
        this.handleApplicationSentData(argument);
        break;
      default:
        log.debug(`Unhandled selector: ${selector}`);
    }

    // Emit message for external listeners
    this.messageEmitter.emit('message', plist);
  }

  /**
   * Handle current state report
   */
  private handleReportCurrentState(arg: any): void {
    this.automationAvailability = arg.WIRAutomationAvailabilityKey || 'WIRAutomationAvailabilityUnknown';
    log.debug(`Automation availability: ${this.automationAvailability}`);
  }

  /**
   * Handle connected application list (automatically sends _rpc_forwardGetListing: for each app)
   */
  private handleReportConnectedApplicationList(arg: any): void {
    this.connectedApplications.clear();
    const apps = arg.WIRApplicationDictionaryKey || {};

    log.debug(`Received ${Object.keys(apps).length} connected applications`);

    for (const [key, appData] of Object.entries(apps)) {
      const app = appData as any;
      this.connectedApplications.set(key, {
        id: key,
        bundle: app.WIRApplicationBundleIdentifierKey || app.WIRApplicationIdentifierKey,
        pid: app.WIRApplicationBundleIdentifierKey ? undefined : parseInt(key.replace('PID:', ''), 10),
        name: app.WIRApplicationNameKey,
        availability: app.WIRAutomationAvailabilityKey || 'WIRAutomationAvailabilityUnknown',
        active: app.WIRIsApplicationActiveKey || 0,
        proxy: app.WIRIsApplicationProxyKey || false,
        ready: app.WIRIsApplicationReadyKey || false,
        host: app.WIRHostApplicationIdentifierKey || '',
      });

      // Automatically send _rpc_forwardGetListing: for this app (like pmd3)
      log.debug(`Auto-requesting listing for app: ${key}`);
      this.forwardGetListing(key).catch((err) => {
        log.warn(`Failed to get listing for ${key}: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Handle application sent listing
   */
  private handleApplicationSentListing(arg: any): void {
    const appId = arg.WIRApplicationIdentifierKey;
    const listing = arg.WIRListingKey || {};

    log.debug(`Received listing for app ${appId}: ${Object.keys(listing).length} pages`);

    if (!this.applicationPages.has(appId)) {
      this.applicationPages.set(appId, new Map());
    }

    const pages = this.applicationPages.get(appId)!;
    for (const [pageId, pageData] of Object.entries(listing)) {
      const page = pageData as any;
      pages.set(parseInt(pageId, 10), {
        id: parseInt(pageId, 10),
        type: page.WIRTypeKey,
        webURL: page.WIRURLKey,
        webTitle: page.WIRTitleKey,
        automationIsPairedKey: page.WIRAutomationTargetIsPairedKey || false,
        automationName: page.WIRAutomationTargetNameKey,
        automationVersion: page.WIRAutomationTargetVersionKey,
        automationSessionId: page.WIRSessionIdentifierKey,
        automationConnectionId: page.WIRConnectionIdentifierKey,
      });
    }
  }

  /**
   * Handle application updated (merge fields into existing entry)
   */
  private handleApplicationUpdated(arg: any): void {
    const appId: string = arg.WIRApplicationIdentifierKey;
    const existing = this.connectedApplications.get(appId) || {};
    const updated = {
      id: appId,
      bundle: arg.WIRApplicationBundleIdentifierKey ?? existing.bundle,
      pid: existing.pid ?? (appId?.startsWith('PID:') ? parseInt(appId.replace('PID:', ''), 10) : undefined),
      name: arg.WIRApplicationNameKey ?? existing.name,
      availability: arg.WIRAutomationAvailabilityKey ?? existing.availability ?? 'WIRAutomationAvailabilityUnknown',
      active: arg.WIRIsApplicationActiveKey ?? existing.active ?? 0,
      proxy: arg.WIRIsApplicationProxyKey ?? existing.proxy ?? false,
      ready: arg.WIRIsApplicationReadyKey ?? existing.ready ?? false,
      host: arg.WIRHostApplicationIdentifierKey ?? existing.host ?? '',
    };
    this.connectedApplications.set(appId, updated);
    log.debug(`Application updated: ${appId} (${updated.name || 'unknown'})`);
  }

  /**
   * Handle application connected
   */
  private handleApplicationConnected(arg: any): void {
    const appId = arg.WIRApplicationIdentifierKey;
    log.debug(`Application connected: ${appId}`);
    // Application data will come in _rpc_reportConnectedApplicationList:
  }

  /**
   * Handle application disconnected
   */
  private handleApplicationDisconnected(arg: any): void {
    const appId = arg.WIRApplicationIdentifierKey;
    log.debug(`Application disconnected: ${appId}`);
    this.connectedApplications.delete(appId);
    this.applicationPages.delete(appId);
  }

  /**
   * Handle application sent data
   */
  private handleApplicationSentData(arg: any): void {
    log.debug('Application sent data:', JSON.stringify(arg).substring(0, 200));
    // This is typically inspector protocol data
  }

  /**
   * Start background receiver that processes messages continuously (like pmd3's _receiving_task)
   */
  private async startBackgroundReceiver(): Promise<void> {
    if (!this.connection) {
      return;
    }

    // Prevent multiple receivers
    if (this.isListening) {
      log.debug('Background receiver already running');
      return;
    }

    this.isListening = true;
    log.debug('Starting background message receiver');

    // Run in background, don't await
    const receiverPromise = (async () => {
      let loopCount = 0;
      let consecutiveTimeouts = 0;
      log.debug('Background receiver async function started');
      while (this.connection && this.isListening) {
        loopCount++;
        log.debug(`Background receiver loop iteration ${loopCount}, isListening=${this.isListening}, hasConnection=${!!this.connection}`);
        try {
          log.debug(`Calling receivePlist with 10s timeout...`);

          // Retry loop like pmd3 to handle incomplete reads
          let message: any = null;
          let retryCount = 0;
          while (retryCount < 3) {
            try {
              message = await this.connection.receivePlist(10000);
              log.debug(`receivePlist returned successfully`);
              break;
            } catch (recvError) {
              const errorMsg = (recvError as Error).message || '';
              if (errorMsg.includes('Unicode') || errorMsg.includes('replacement') || errorMsg.includes('encoding')) {
                // Incomplete/corrupted plist data - retry like pmd3
                retryCount++;
                log.debug(`Incomplete plist data (attempt ${retryCount}/3), retrying...`);
                await new Promise(resolve => setTimeout(resolve, 100)); // Brief delay
                continue;
              }
              // Not an incomplete read error, rethrow
              throw recvError;
            }
          }

          if (!message) {
            log.warn('Failed to receive valid plist after 3 attempts');
            continue;
          }

          // Reset timeout counter on successful receive
          consecutiveTimeouts = 0;

          log.debug(`Background receiver got message (loop ${loopCount}): ${JSON.stringify(message).substring(0, 500)}`);

          if (message && typeof message === 'object') {
            // Skip StartService responses that might arrive late
            if ((message as any).Request === 'StartService') {
              log.debug('Skipping StartService response in background receiver');
              continue;
            }

            // Handle the message (updates internal state, sends auto-requests)
            this.handleIncomingMessage(message);
          }
        } catch (error) {
          log.debug(`receivePlist threw error: ${(error as Error).message}`);
          // Timeouts are normal, just continue
          const errorMsg = (error as Error).message || '';
          if (errorMsg.includes('timeout') || errorMsg.includes('timed out') || errorMsg.includes('Timed out')) {
            // This is normal - just means no messages arrived
            consecutiveTimeouts++;
            log.debug(`Background receiver timeout (loop ${loopCount}, ${consecutiveTimeouts} consecutive), continuing...`);

            // After several consecutive timeouts, warn that WebInspector might not be enabled
            if (consecutiveTimeouts === 3) {
              log.warn('WebInspector not receiving any messages after 3 timeouts.');
              log.warn('This likely means WebInspector is not enabled on device.');
              log.warn('To enable: Settings → Safari → Advanced → Web Inspector');
            }
            continue;
          }
          // Other errors might indicate connection issues
          log.warn(`Background receiver error: ${errorMsg}`);

          // If connection is closed, exit loop
          if (!this.connection || !this.isListening) {
            log.debug('Connection closed or not listening, breaking loop');
            break;
          }
        }
        log.debug(`End of loop iteration ${loopCount}, continuing to next iteration`);
      }
      log.debug(`Background receiver stopped after ${loopCount} iterations, isListening=${this.isListening}`);
    })();

    receiverPromise.catch((err) => {
      log.error(`Background receiver fatal error: ${(err as Error).message}`);
      log.error(err.stack);
    });
  }

  /**
   * Send a message directly without waiting for response (fire-and-forget)
   */
  private sendWebInspectorMessageDirectly(
    selector: string,
    args: PlistDictionary = {},
  ): void {
    if (!this.connection) {
      throw new Error('Connection not established');
    }

    // Add connection identifier to all messages
    const messageArgs: PlistDictionary = {
      ...args,
      WIRConnectionIdentifierKey: this.connectionId,
    };

    const message: WebInspectorMessage = {
      __selector: selector,
      __argument: messageArgs,
    };

    const messageStr = JSON.stringify(message);
    log.debug(`Sending WebInspector message: ${selector}`);
    log.debug(`Message content: ${messageStr.substring(0, 300)}`);

    // Fire-and-forget send (no response expected)
    this.connection.sendPlist(message);
    log.debug(`sendPlist() completed for ${selector}`);
  }

  /**
   * Send a message to the WebInspector service
   * @param selector The RPC selector (e.g., '_rpc_reportIdentifier:')
   * @param args The arguments dictionary for the message
   * @returns Promise that resolves when the message is sent
   */
  async sendMessage(
    selector: string,
    args: PlistDictionary = {},
  ): Promise<void> {
    if (!this.connection) {
      await this.connectToWebInspectorService();
    }

    this.sendWebInspectorMessageDirectly(selector, args);
  }

  /**
   * Listen to messages from the WebInspector service
   * @param callback Callback function that will be called for each received message
   * @returns Promise that resolves when listening starts
   */
  async listenMessage(
    callback: (message: PlistMessage) => void,
  ): Promise<void> {
    if (!this.connection) {
      await this.connectToWebInspectorService();
    }

    // Add callback to listeners
    this.messageEmitter.on('message', callback);

    // Background receiver is already running (started in reportIdentifier)
    // Just need to make sure it's started
    if (!this.isListening) {
      await this.startBackgroundReceiver();
    }
    const count = this.messageEmitter.listenerCount('message');
    log.debug(`Added message listener. Total listeners: ${count} (background receiver handles messages)`);
  }

  /**
   * Start receiving messages from the WebInspector service
   */
  private async startMessageReceiver(): Promise<void> {
    if (!this.connection) {
      return;
    }

    log.debug('Starting WebInspector message receiver');

    try {
      while (this.isListening) {
        try {
          // Use a moderate timeout for continuous listening (5 seconds)
          // WebInspector messages are event-driven, not constant
          const message = await this.connection.receive(5000);

          const messageStr = JSON.stringify(message);
          const truncatedStr =
            messageStr.length > 500
              ? `${messageStr.substring(0, 500)}...`
              : messageStr;
          log.debug(`Received WebInspector message: ${truncatedStr}`);

          // Skip the StartService response if we somehow get it here
          if (message && typeof message === 'object' &&
            (message as any).Request === 'StartService') {
            log.debug('Skipping StartService response in message receiver');
            continue;
          }

          // Emit the message to all listeners
          this.messageEmitter.emit('message', message);
        } catch (error) {
          if (this.isListening) {
            // If we timeout, just continue the loop - no messages available yet
            const errorMsg = (error as Error).message;
            if (errorMsg.includes('Timed out')) {
              // Timeout is normal when no messages are being sent
              continue;
            }
            log.error(`Error receiving WebInspector message: ${errorMsg}`);
          }
          break;
        }
      }
    } catch (error) {
      log.error(
        `Message receiver error: ${(error as Error).message}`,
      );
    }

    log.debug('Stopped WebInspector message receiver');
  }

  /**
   * Stop listening to messages
   * Note: This only removes external callbacks, the background receiver continues
   * to run for automatic message handling
   */
  stopListening(): void {
    this.messageEmitter.removeAllListeners('message');
    log.debug('Stopped listening for WebInspector messages');
  }



  /**
   * Close the connection and clean up resources
   */
  async close(): Promise<void> {
    // Stop the background receiver
    this.isListening = false;
    this.messageEmitter.removeAllListeners('message');

    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      log.debug('WebInspector connection closed');
    }
  }

  /**
   * Get the connection ID being used for this service
   * @returns The connection identifier
   */
  getConnectionId(): string {
    return this.connectionId;
  }

  // Convenience methods for common WebInspector operations

  /**
   * Request application launch
   * @param bundleId The bundle identifier of the application to launch
   */
  async requestApplicationLaunch(bundleId: string): Promise<void> {
    await this.sendMessage('_rpc_requestApplicationLaunch:', {
      WIRApplicationBundleIdentifierKey: bundleId,
    });
  }

  /**
   * Get connected applications
   */
  async getConnectedApplications(): Promise<void> {
    await this.sendMessage('_rpc_getConnectedApplications:', {});
  }

  /**
   * Forward get listing for an application
   * @param appId The application identifier
   */
  async forwardGetListing(appId: string): Promise<void> {
    await this.sendMessage('_rpc_forwardGetListing:', {
      WIRApplicationIdentifierKey: appId,
    });
  }

  /**
   * Forward automation session request
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param capabilities Optional session capabilities
   */
  async forwardAutomationSessionRequest(
    sessionId: string,
    appId: string,
    capabilities?: PlistDictionary,
  ): Promise<void> {
    const defaultCapabilities: PlistDictionary = {
      'org.webkit.webdriver.webrtc.allow-insecure-media-capture': true,
      'org.webkit.webdriver.webrtc.suppress-ice-candidate-filtering': false,
    };

    await this.sendMessage('_rpc_forwardAutomationSessionRequest:', {
      WIRApplicationIdentifierKey: appId,
      WIRSessionIdentifierKey: sessionId,
      WIRSessionCapabilitiesKey: capabilities || defaultCapabilities,
    });
  }

  /**
   * Forward socket setup for inspector connection
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param automaticallyPause Whether to automatically pause (defaults to true)
   */
  async forwardSocketSetup(
    sessionId: string,
    appId: string,
    pageId: number,
    automaticallyPause: boolean = true,
  ): Promise<void> {
    const message: PlistDictionary = {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRSenderKey: sessionId,
      WIRMessageDataTypeChunkSupportedKey: 0,
    };

    if (!automaticallyPause) {
      message.WIRAutomaticallyPause = false;
    }

    await this.sendMessage('_rpc_forwardSocketSetup:', message);
  }

  /**
   * Forward socket data to a page
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param data The data to send (will be JSON stringified)
   */
  async forwardSocketData(
    sessionId: string,
    appId: string,
    pageId: number,
    data: any,
  ): Promise<void> {
    const socketData =
      typeof data === 'string' ? data : JSON.stringify(data);

    await this.sendMessage('_rpc_forwardSocketData:', {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRSessionIdentifierKey: sessionId,
      WIRSenderKey: sessionId,
      WIRSocketDataKey: Buffer.from(socketData, 'utf-8'),
    });
  }

  /**
   * Forward indicate web view
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param enable Whether to enable indication
   */
  async forwardIndicateWebView(
    appId: string,
    pageId: number,
    enable: boolean,
  ): Promise<void> {
    await this.sendMessage('_rpc_forwardIndicateWebView:', {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRIndicateEnabledKey: enable,
    });
  }

  /**
   * Get all open pages from all applications (like pmd3's get_open_application_pages)
   * This triggers the query and waits for responses
   * @param timeout Time to wait for responses in milliseconds (default 3000)
   */
  async getOpenApplicationPages(timeout: number = 3000): Promise<Array<{ application: any; page: any }>> {
    // Trigger the query
    await this.getConnectedApplications();

    // Wait for responses to arrive (messages are handled in background)
    await new Promise(resolve => setTimeout(resolve, timeout));

    // Collect results from internal state
    const result: Array<{ application: any; page: any }> = [];

    for (const [appId, app] of this.connectedApplications) {
      const pages = this.applicationPages.get(appId);
      if (pages) {
        for (const [pageId, page] of pages) {
          result.push({ application: app, page });
        }
      }
    }

    log.debug(`Found ${result.length} open pages across ${this.connectedApplications.size} applications`);
    return result;
  }

  /**
   * Get current connected applications (from internal state)
   */
  getConnectedApplicationsSync(): Map<string, any> {
    return new Map(this.connectedApplications);
  }

  /**
   * Get application pages (from internal state)
   */
  getApplicationPagesSync(): Map<string, Map<number, any>> {
    return new Map(this.applicationPages);
  }

  /**
   * Get automation availability
   */
  getAutomationAvailability(): string {
    return this.automationAvailability;
  }
}

export default WebInspectorService;
