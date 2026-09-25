import type {IXPCFileTransfer} from '../types.js';

/**
 * An outbound XPC file transfer (`XPC_TYPE_FILE_TRANSFER`).
 *
 * Placing one in a request only announces the payload (its size and a transfer id);
 * the bytes follow on their own HTTP/2 stream via
 * {@link RemoteXpcFramedTransport.sendFileTransfer} with the same id.
 *
 * @example
 * ```ts
 * const argv = {image: new XPCFileTransfer(1, image.length)};
 * // send the request, then:
 * await transport.sendFileTransfer(1, image);
 * ```
 */
export class XPCFileTransfer implements IXPCFileTransfer {
  readonly transferId: number;
  readonly size: number;

  /**
   * @param transferId Non-zero id correlating the announcement with its payload stream;
   * the device drops the connection on id 0.
   * @param size Payload length in bytes.
   */
  constructor(transferId: number, size: number) {
    if (!Number.isSafeInteger(transferId) || transferId <= 0) {
      throw new TypeError(`XPC file transfer id must be a positive integer, got ${transferId}`);
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`XPC file transfer size must be a non-negative integer, got ${size}`);
    }
    this.transferId = transferId;
    this.size = size;
  }
}

export default XPCFileTransfer;
