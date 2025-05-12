import type { PlistValue } from '../types.js';
import { isBinaryPlist, parseBinaryPlist } from './binary-plist-parser.js';
import { parsePlist as parseXmlPlist } from './plist-parser.js';

/**
 * Unified plist parser that can handle both XML and binary plists
 * @param data - The plist data as a string or Buffer
 * @returns The parsed JavaScript object
 */
export function parsePlist(data: string | Buffer): PlistValue {
  try {
    // Convert string to Buffer if needed
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;

    // Check if it's a binary plist
    if (isBinaryPlist(buffer)) {
      return parseBinaryPlist(buffer);
    }

    // Otherwise, assume it's an XML plist
    const xmlStr = buffer.toString('utf8');
    return parseXmlPlist(xmlStr);
  } catch (error) {
    // Add more context to the error
    throw new Error(
      `Failed to parse plist: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
