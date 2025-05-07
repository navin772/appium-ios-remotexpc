import { logger } from '@appium/support';
import net from 'node:net';

import Handshake from './handshake.js';

const log = logger.getLogger('RemoteXpcConnection');

interface Service {
  serviceName: string;
  port: string;
}

interface ServicesResponse {
  services: Service[];
}

class RemoteXpcConnection {
  private readonly _address: [string, number];
  private _socket: net.Socket | undefined;
  private _handshake: Handshake | undefined;
  private _isConnected: boolean;
  private _services: Service[] | undefined;

  constructor(address: [string, number]) {
    this._address = address;
    this._socket = undefined;
    this._handshake = undefined;
    this._isConnected = false;
    this._services = undefined;
  }

  /**
   * Connect to the remote device and perform handshake
   * @returns Promise that resolves with the list of available services
   */
  async connect(): Promise<ServicesResponse> {
    if (this._isConnected) {
      throw new Error('Already connected');
    }

    return new Promise((resolve, reject) => {
      try {
        this._socket = net.connect({
          host: this._address[0],
          port: this._address[1],
          family: 6,
        });

        this._socket.setNoDelay(true);
        this._socket.setKeepAlive(true);

        this._socket.once('error', (error) => {
          log.error(`Connection error: ${error}`);
          this._isConnected = false;
          reject(error);
        });

        // Handle incoming data
        this._socket.on('data', (data) => {
          if (Buffer.isBuffer(data) || typeof data === 'string') {
            const buffer = Buffer.isBuffer(data)
              ? data
              : Buffer.from(data, 'hex');

            if (buffer.length > 100) {
              const response = buffer.toString('utf8');
              const servicesResponse = extractServices(response);
              this._services = servicesResponse.services;
              resolve(servicesResponse);
            }
          }
        });

        this._socket.on('close', () => {
          log.info('Socket closed');
          this._isConnected = false;
        });

        this._socket.once('connect', async () => {
          try {
            this._isConnected = true;
            if (this._socket) {
              this._handshake = new Handshake(this._socket);
              // Once handshake is successful we can get
              // peer-info and get ports for lockdown in RSD
              await this._handshake.perform();
            }
          } catch (error) {
            log.error(`Handshake failed: ${error}`);
            await this.close();
            reject(error);
          }
        });
      } catch (error) {
        log.error(`Failed to create connection: ${error}`);
        reject(error);
      }
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this._socket) {
      return new Promise((resolve) => {
        this._socket!.end(() => {
          this._socket = undefined;
          this._isConnected = false;
          this._handshake = undefined;
          this._services = undefined;
          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  /**
   * Get the list of available services
   * @returns Array of available services
   */
  getServices(): Service[] {
    if (!this._services) {
      throw new Error('Not connected or services not available');
    }
    return this._services;
  }

  /**
   * List all available services
   * @returns Array of all available services
   */
  listAllServices(): Service[] {
    return this.getServices();
  }

  /**
   * Find a service by name
   * @param serviceName The name of the service to find
   * @returns The service or throws an error if not found
   */
  findService(serviceName: string): Service {
    const services = this.getServices();
    const service = services.find(
      (service) => service.serviceName === serviceName,
    );
    if (!service) {
      throw new Error(`Service ${serviceName} not found, 
        Check if the device is locked.`);
    }
    return service;
  }
}

/**
 * Extract services from the response
 * @param response The response string to parse
 * @returns Object containing the extracted services
 */
function extractServices(response: string): ServicesResponse {
  const regex = /com\.apple(?:\.[\w-]+)+|Port[^0-9]*(\d+)/g;

  const items: Array<{ type: string; value: string; index: number }> = [];
  for (const match of response.matchAll(regex)) {
    // match.index gives the position in the string
    if (match[0].startsWith('com.apple')) {
      items.push({ type: 'service', value: match[0], index: match.index });
    } else if (match[0].startsWith('Port')) {
      // The captured group (match[1]) is the port number.
      items.push({ type: 'port', value: match[1], index: match.index });
    }
  }

  const services: Service[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type === 'service') {
      // If the next item is also a service, skip the current one.
      if (i + 1 < items.length && items[i + 1].type === 'service') {
        continue;
      }
      // Look ahead for the next port occurrence.
      let port: string | undefined;
      for (let j = i + 1; j < items.length; j++) {
        if (items[j].type === 'port') {
          port = items[j].value;
          break;
        }
      }
      // If no port is found, default to an empty string.
      services.push({ serviceName: items[i].value, port: port || '' });
    }
  }
  return { services };
}

export default RemoteXpcConnection;
export { type Service, type ServicesResponse };
