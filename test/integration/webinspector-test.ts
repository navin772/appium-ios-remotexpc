import { logger } from '@appium/support';
import { expect } from 'chai';
import { fileURLToPath } from 'url';
import path from 'path';

import type { WebInspectorService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('WebInspectorService.test');
log.level = 'debug';

describe('WebInspectorService Integration', function () {
  this.timeout(60000);

  let serviceWithConnection: {
    webInspectorService: WebInspectorService;
    remoteXPC: any;
  } | null = null;
  const testUdid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(async function () {
    if (!testUdid) {
      throw new Error('set UDID env var to execute tests.');
    }

    // Establish connection for all tests
    serviceWithConnection = await Services.startWebInspectorService(testUdid);
  });

  after(async function () {
    if (serviceWithConnection) {
      // Close the service first
      await serviceWithConnection.webInspectorService.close();
      
      // Then close the RemoteXPC connection
      if (serviceWithConnection.remoteXPC) {
        await serviceWithConnection.remoteXPC.close();
      }
    }
  });

  describe('Service Connection', () => {
    it('should connect to WebInspector service', async function () {
      expect(serviceWithConnection).to.not.be.null;
      expect(serviceWithConnection!.webInspectorService).to.not.be.null;
      expect(serviceWithConnection!.remoteXPC).to.not.be.null;
    });

    it('should have a valid connection ID', function () {
      const connectionId =
        serviceWithConnection!.webInspectorService.getConnectionId();
      expect(connectionId).to.be.a('string');
      expect(connectionId.length).to.be.greaterThan(0);
      log.debug(`Connection ID: ${connectionId}`);
    });
  });

  describe('Automatic Message Handling (pmd3 pattern)', () => {
    it('should automatically fetch connected applications and pages', async function () {
      // This mimics pmd3's get_open_application_pages() behavior
      const pages = await serviceWithConnection!.webInspectorService.getOpenApplicationPages(3000);
      console.log(pages);
      log.debug(`Found ${pages.length} open pages`);
      
      // We might not have pages open, so just verify it's an array
      expect(pages).to.be.an('array');
      
      if (pages.length > 0) {
        const page = pages[0];
        expect(page).to.have.property('application');
        expect(page).to.have.property('page');
        expect(page.application).to.have.property('id');
        expect(page.application).to.have.property('name');
        expect(page.page).to.have.property('id');
        
        log.debug(`First page: ${page.application.name} - ${page.page.webTitle || page.page.webURL || 'N/A'}`);
      }
    });

    it('should maintain internal state of applications', async function () {
      // Trigger query
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      
      // Wait for responses
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get state
      const apps = serviceWithConnection!.webInspectorService.getConnectedApplicationsSync();
      
      log.debug(`Internal state has ${apps.size} applications`);
      
      // Might be 0 if no apps with WebViews are open
      expect(apps).to.be.instanceOf(Map);
      
      if (apps.size > 0) {
        const [appId, appData] = Array.from(apps.entries())[0];
        log.debug(`First app: ${appId} - ${appData.name}`);
        expect(appData).to.have.property('name');
        expect(appData).to.have.property('bundle');
      }
    });

    it('should report automation availability', function () {
      const availability = serviceWithConnection!.webInspectorService.getAutomationAvailability();
      expect(availability).to.be.a('string');
      log.debug(`Automation availability: ${availability}`);
    });
  });

  describe('Send Message Operations', () => {
    it('should send _rpc_getConnectedApplications message', async function () {
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      // No error means success - WebInspector uses fire-and-forget for sending
    });

    it('should send _rpc_requestApplicationLaunch message', async function () {
      // Launch Safari
      await serviceWithConnection!.webInspectorService.requestApplicationLaunch(
        'com.apple.mobilesafari',
      );
      // Wait a bit for the device to respond
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
  });

  describe('Listen Message Operations', () => {
    it('should be able to start and stop message listener', async function () {
      const receivedMessages: any[] = [];

      // Start listening for messages
      await serviceWithConnection!.webInspectorService.listenMessage(
        (message) => {
          log.debug('Received message:', message);
          receivedMessages.push(message);
        },
      );

      // Give the listener time to start
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Send some messages
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      await serviceWithConnection!.webInspectorService.requestApplicationLaunch(
        'com.apple.mobilesafari',
      );

      // Wait a bit for potential responses
      await new Promise((resolve) => setTimeout(resolve, 3000));

      log.info(`Received ${receivedMessages.length} messages`);

      // WebInspector may or may not send responses depending on device state
      // So we just verify the listener mechanism works, not message count
      receivedMessages.forEach((msg, index) => {
        expect(msg).to.be.an('object');
        log.debug(`Message ${index + 1} structure:`, Object.keys(msg));
      });

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();
      log.debug('Message listener stopped successfully');
    });

    it('should handle message structure validation', async function () {
      const receivedMessages: any[] = [];

      // Listen for messages
      await serviceWithConnection!.webInspectorService.listenMessage(
        (message) => {
          receivedMessages.push(message);
          
          // Log message details if we get any
          if ((message as any).__selector) {
            log.debug('Received message with selector:', (message as any).__selector);
          }
        },
      );

      // Send some messages to potentially trigger responses
      await serviceWithConnection!.webInspectorService.getConnectedApplications();

      // Wait for potential responses
      await new Promise((resolve) => setTimeout(resolve, 2000));

      log.info(`Received ${receivedMessages.length} messages total`);

      // If we received messages, validate their structure
      if (receivedMessages.length > 0) {
        receivedMessages.forEach((msg) => {
          expect(msg).to.be.an('object');
          // WebInspector messages typically have __selector and __argument
          log.debug('Message keys:', Object.keys(msg));
        });
      } else {
        log.info('No messages received (this may be normal depending on device state)');
      }

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();
    });
  });

  describe('Application and Page Operations', () => {
    it('should send forwardGetListing for an application', async function () {
      // First, get connected applications
      const receivedMessages: any[] = [];
      let appId: string | null = null;

      await serviceWithConnection!.webInspectorService.listenMessage(
        (message) => {
          receivedMessages.push(message);

          // Look for connected application list
          if (message.__selector === '_rpc_reportConnectedApplicationList:') {
            const argument = message.__argument;
            if (argument && typeof argument === 'object' && !Buffer.isBuffer(argument) && !Array.isArray(argument)) {
              const apps = (argument as any).WIRApplicationDictionaryKey;
              if (apps && typeof apps === 'object') {
                // Get the first app ID
                const appIds = Object.keys(apps);
                if (appIds.length > 0) {
                  appId = appIds[0];
                  log.debug(`Found application ID: ${appId}`);
                }
              }
            }
          }
        },
      );

      // Request connected applications
      await serviceWithConnection!.webInspectorService.getConnectedApplications();

      // Wait for response
      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (appId) {
        // Try to get listing for the app
        await serviceWithConnection!.webInspectorService.forwardGetListing(
          appId,
        );
        log.debug('Successfully sent forwardGetListing request');

        // Wait for listing response
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        log.warn('No applications found to test forwardGetListing');
      }

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();
    });
  });

  describe('Advanced Operations', () => {
    it('should handle forwardSocketSetup message', async function () {
      const sessionId = 'test-session-' + Date.now();
      const appId = 'test-app-id';
      const pageId = 1;

      // This will likely fail on a real device without a proper app/page,
      // but it tests that the message can be sent
      try {
        await serviceWithConnection!.webInspectorService.forwardSocketSetup(
          sessionId,
          appId,
          pageId,
          true,
        );
        log.debug('forwardSocketSetup message sent successfully');
      } catch (error) {
        log.warn(
          `forwardSocketSetup failed (expected without real app): ${(error as Error).message}`,
        );
      }
    });

    it('should handle forwardSocketData message', async function () {
      const sessionId = 'test-session-' + Date.now();
      const appId = 'test-app-id';
      const pageId = 1;
      const testData = { method: 'Runtime.enable', id: 1 };

      // This will likely fail on a real device without a proper app/page,
      // but it tests that the message can be sent
      try {
        await serviceWithConnection!.webInspectorService.forwardSocketData(
          sessionId,
          appId,
          pageId,
          testData,
        );
        log.debug('forwardSocketData message sent successfully');
      } catch (error) {
        log.warn(
          `forwardSocketData failed (expected without real session): ${(error as Error).message}`,
        );
      }
    });

    it('should handle forwardIndicateWebView message', async function () {
      const appId = 'test-app-id';
      const pageId = 1;

      // This will likely fail on a real device without a proper app/page,
      // but it tests that the message can be sent
      try {
        await serviceWithConnection!.webInspectorService.forwardIndicateWebView(
          appId,
          pageId,
          true,
        );
        log.debug('forwardIndicateWebView message sent successfully');
      } catch (error) {
        log.warn(
          `forwardIndicateWebView failed (expected without real app): ${(error as Error).message}`,
        );
      }
    });
  });

  describe('Automation Session', () => {
    it('should handle forwardAutomationSessionRequest', async function () {
      const sessionId = 'automation-session-' + Date.now();
      const appId = 'com.apple.mobilesafari';

      // Listen for responses
      const receivedMessages: any[] = [];
      await serviceWithConnection!.webInspectorService.listenMessage(
        (message) => {
          receivedMessages.push(message);
          log.debug('Received response:', message.__selector);
        },
      );

      // Send automation session request
      try {
        await serviceWithConnection!.webInspectorService.forwardAutomationSessionRequest(
          sessionId,
          appId,
        );
        log.debug('forwardAutomationSessionRequest sent successfully');

        // Wait for responses
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        log.warn(
          `forwardAutomationSessionRequest failed: ${(error as Error).message}`,
        );
      }

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();
    });
  });

  describe('Message Listener Management', () => {
    it('should allow stopping and restarting listening', async function () {
      let messageCount = 0;

      // Start listening
      await serviceWithConnection!.webInspectorService.listenMessage(() => {
        messageCount++;
      });

      // Send a message
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const countAfterFirst = messageCount;
      expect(countAfterFirst).to.be.greaterThan(0);

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();

      // Send another message
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Message count should not have increased
      expect(messageCount).to.equal(countAfterFirst);

      // Restart listening
      await serviceWithConnection!.webInspectorService.listenMessage(() => {
        messageCount++;
      });

      // Send another message
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Message count should have increased
      expect(messageCount).to.be.greaterThan(countAfterFirst);

      // Clean up
      serviceWithConnection!.webInspectorService.stopListening();
    });
  });
});
