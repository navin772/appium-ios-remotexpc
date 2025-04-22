import net from 'node:net';
import { BasePlistService } from './base-plist-service.js';

export interface ServiceConnectionOptions {
  keepAlive?: boolean;
  createConnectionTimeout?: number;
}

/**
 * ServiceConnection for communicating with Apple device services over TCP
 */
export class ServiceConnection extends BasePlistService {
  constructor(socket: net.Socket) {
    super(socket);
  }

  /**
   * Creates a TCP connection to the specified host and port
   */
  static createUsingTCP(
    hostname: string,
    port: string,
    options?: ServiceConnectionOptions,
  ): Promise<ServiceConnection> {
    const keepAlive = options?.keepAlive ?? true;
    const createConnectionTimeout = options?.createConnectionTimeout ?? 30000;

    return new Promise<ServiceConnection>((resolve, reject) => {
      const socket = net.createConnection(
        { host: hostname, port: Number(port) },
        () => {
          socket.setTimeout(0);
          if (keepAlive) socket.setKeepAlive(true);
          resolve(new ServiceConnection(socket));
        },
      );

      socket.setTimeout(createConnectionTimeout, () => {
        socket.destroy();
        reject(new Error('Connection timed out'));
      });

      socket.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Sends a plist request to the device and returns the response
   */
  sendPlistRequest(
    requestObj: Record<string, any>,
    timeout = 10000
  ): Promise<Record<string, any>> {
    return this.sendAndReceive(requestObj, timeout);
  }

  /**
   * Gets the underlying socket
   */
  getSocket(): net.Socket {
    return this.getPlistService().getSocket() as net.Socket;
  }

  /**
   * Closes the connection
   */
  close(): void {
    super.close();
  }
}

export default ServiceConnection;
