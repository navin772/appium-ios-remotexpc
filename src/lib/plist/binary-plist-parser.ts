/**
 * Binary Property List (bplist) Parser
 *
 * This module provides functionality to parse binary property lists (bplists)
 * commonly used in Apple's iOS and macOS systems.
 */
import { logger } from '@appium/support';

import type { PlistArray, PlistDictionary, PlistValue } from '../types.js';

const log = logger.getLogger('Plist');

/**
 * Represents a temporary object during binary plist parsing
 */
interface TempObject {
  type: 'array' | 'dict';
  objLength: number;
  startOffset: number;
  value: PlistArray | PlistDictionary;
}

/**
 * Type for the object table during parsing
 */
type ObjectTableItem = PlistValue | TempObject;

// Constants for binary plist format
const BPLIST_MAGIC = 'bplist';
const BPLIST_VERSION = '00';
const BPLIST_MAGIC_AND_VERSION = Buffer.from(
  `${BPLIST_MAGIC}${BPLIST_VERSION}`,
);

// Object types in binary plist
const BPLIST_TYPE = {
  NULL: 0x00,
  FALSE: 0x08,
  TRUE: 0x09,
  FILL: 0x0f,
  INT: 0x10,
  REAL: 0x20,
  DATE: 0x30,
  DATA: 0x40,
  STRING_ASCII: 0x50,
  STRING_UNICODE: 0x60,
  UID: 0x80,
  ARRAY: 0xa0,
  SET: 0xc0,
  DICT: 0xd0,
};

/**
 * Class for parsing binary property lists
 */
class BinaryPlistParser {
  _buffer: Buffer;
  _offsetSize: number;
  _objectRefSize: number;
  _numObjects: number;
  _topObject: number;
  _offsetTableOffset: number;
  _objectTable: ObjectTableItem[];

  /**
   * Creates a new BinaryPlistParser
   * @param buffer - The binary plist data as a Buffer
   */
  constructor(buffer: Buffer) {
    this._buffer = buffer;
    this._objectTable = [];

    // Initialize with default values, will be set in parseTrailer
    this._offsetSize = 0;
    this._objectRefSize = 0;
    this._numObjects = 0;
    this._topObject = 0;
    this._offsetTableOffset = 0;
  }

  /**
   * Validates the binary plist header
   * @throws Error if the buffer is not a valid binary plist
   */
  _validateHeader(): void {
    if (
      this._buffer.length < 8 ||
      !this._buffer.slice(0, 8).equals(BPLIST_MAGIC_AND_VERSION)
    ) {
      throw new Error('Not a binary plist. Expected bplist00 magic.');
    }
  }

  /**
   * Parses the trailer section of the binary plist
   * @throws Error if the buffer is too small to contain a trailer
   */
  _parseTrailer(): void {
    const trailerSize = 32; // Last 32 bytes are the trailer
    if (this._buffer.length < trailerSize) {
      throw new Error('Binary plist is too small to contain a trailer.');
    }

    const trailer = this._buffer.slice(this._buffer.length - trailerSize);

    // Extract trailer information
    this._offsetSize = trailer.readUInt8(6);
    this._objectRefSize = trailer.readUInt8(7);
    this._numObjects = Number(trailer.readBigUInt64BE(8));
    this._topObject = Number(trailer.readBigUInt64BE(16));
    this._offsetTableOffset = Number(trailer.readBigUInt64BE(24));
  }

  /**
   * Reads an object reference from the buffer
   * @param offset - The offset to read from
   * @returns The object reference index
   */
  _readObjectRef(offset: number): number {
    let result = 0;
    for (let i = 0; i < this._objectRefSize; i++) {
      result = (result << 8) | this._buffer.readUInt8(offset + i);
    }
    return result;
  }

  /**
   * Reads an offset from the offset table
   * @param index - The index in the offset table
   * @returns The offset value
   */
  _readOffset(index: number): number {
    const offsetStart = this._offsetTableOffset + index * this._offsetSize;
    let result = 0;
    for (let i = 0; i < this._offsetSize; i++) {
      result = (result << 8) | this._buffer.readUInt8(offsetStart + i);
    }
    return result;
  }

  /**
   * Parses an integer value from the buffer
   * @param startOffset - The offset to start reading from
   * @param intByteCount - The number of bytes to read
   * @returns The parsed integer value
   */
  _parseIntegerValue(startOffset: number, intByteCount: number): number {
    let intValue = 0;

    // Handle different integer sizes
    if (intByteCount === 1) {
      intValue = this._buffer.readInt8(startOffset);
    } else if (intByteCount === 2) {
      intValue = this._buffer.readInt16BE(startOffset);
    } else if (intByteCount === 4) {
      intValue = this._buffer.readInt32BE(startOffset);
    } else if (intByteCount === 8) {
      // For 64-bit integers, we need to handle potential precision loss
      const bigInt = this._buffer.readBigInt64BE(startOffset);
      intValue = Number(bigInt);
      // Check if conversion to Number caused precision loss
      if (BigInt(intValue) !== bigInt) {
        log.warn('Precision loss when converting 64-bit integer to Number');
      }
    }

    return intValue;
  }

  /**
   * Parses a real (floating point) value from the buffer
   * @param startOffset - The offset to start reading from
   * @param floatByteCount - The number of bytes to read
   * @returns The parsed floating point value
   */
  _parseRealValue(startOffset: number, floatByteCount: number): number {
    if (floatByteCount === 4) {
      return this._buffer.readFloatBE(startOffset);
    } else if (floatByteCount === 8) {
      return this._buffer.readDoubleBE(startOffset);
    }
    return 0;
  }

  /**
   * Parses a date value from the buffer
   * @param startOffset - The offset to start reading from
   * @returns The parsed Date object
   */
  _parseDateValue(startOffset: number): Date {
    // Date is stored as a float, seconds since 2001-01-01
    const timestamp = this._buffer.readDoubleBE(startOffset);
    // Convert Apple epoch (2001-01-01) to Unix epoch (1970-01-01)
    const APPLE_EPOCH_OFFSET = 978307200; // Seconds between 1970 and 2001
    return new Date((timestamp + APPLE_EPOCH_OFFSET) * 1000);
  }

  /**
   * Parses a data value from the buffer
   * @param startOffset - The offset to start reading from
   * @param objLength - The length of the data
   * @returns The parsed Buffer
   */
  _parseDataValue(startOffset: number, objLength: number): Buffer {
    return Buffer.from(
      this._buffer.slice(startOffset, startOffset + objLength),
    );
  }

  /**
   * Parses an ASCII string from the buffer
   * @param startOffset - The offset to start reading from
   * @param objLength - The length of the string
   * @returns The parsed string
   */
  _parseAsciiString(startOffset: number, objLength: number): string {
    return this._buffer
      .slice(startOffset, startOffset + objLength)
      .toString('ascii');
  }

  /**
   * Parses a Unicode string from the buffer
   * @param startOffset - The offset to start reading from
   * @param objLength - The length of the string in characters
   * @returns The parsed string
   */
  _parseUnicodeString(startOffset: number, objLength: number): string {
    // Unicode strings are stored as UTF-16BE
    const utf16Buffer = Buffer.alloc(objLength * 2);
    for (let j = 0; j < objLength; j++) {
      utf16Buffer.writeUInt16BE(
        this._buffer.readUInt16BE(startOffset + j * 2),
        j * 2,
      );
    }
    return utf16Buffer.toString('utf16le', 0, objLength * 2);
  }

  /**
   * Parses a UID value from the buffer
   * @param startOffset - The offset to start reading from
   * @param uidByteCount - The number of bytes to read
   * @returns The parsed UID value
   */
  _parseUidValue(startOffset: number, uidByteCount: number): number {
    let uidValue = 0;
    for (let j = 0; j < uidByteCount; j++) {
      uidValue = (uidValue << 8) | this._buffer.readUInt8(startOffset + j);
    }
    return uidValue;
  }

  /**
   * Parses all objects in the binary plist
   */
  _parseObjects(): void {
    for (let i = 0; i < this._numObjects; i++) {
      const objOffset = this._readOffset(i);
      const objType = this._buffer.readUInt8(objOffset) & 0xf0;
      const objInfo = this._buffer.readUInt8(objOffset) & 0x0f;

      let objLength = objInfo;
      let startOffset = objOffset + 1;

      // For objects with length > 15, the actual length follows
      if (objInfo === 0x0f) {
        const intType = this._buffer.readUInt8(startOffset) & 0xf0;
        if (intType !== BPLIST_TYPE.INT) {
          throw new Error(
            `Expected integer type for length at offset ${startOffset}`,
          );
        }

        const intInfo = this._buffer.readUInt8(startOffset) & 0x0f;
        startOffset++;

        // Read the length based on the integer size
        objLength = 0;
        const intByteCount = 1 << intInfo;
        for (let j = 0; j < intByteCount; j++) {
          objLength =
            (objLength << 8) | this._buffer.readUInt8(startOffset + j);
        }
        startOffset += intByteCount;
      }

      // Parse the object based on its type
      this._objectTable[i] = this._parseObjectByType(
        objType,
        objInfo,
        startOffset,
        objLength,
      );
    }
  }

  /**
   * Parses an object based on its type
   * @param objType - The object type
   * @param objInfo - The object info
   * @param startOffset - The start offset
   * @param objLength - The object length
   * @returns The parsed object
   */
  _parseObjectByType(
    objType: number,
    objInfo: number,
    startOffset: number,
    objLength: number,
  ): PlistValue | TempObject {
    switch (objType) {
      case BPLIST_TYPE.NULL:
        return this._parseNullType(objInfo);

      case BPLIST_TYPE.INT:
        return this._parseIntegerValue(startOffset, 1 << objInfo);

      case BPLIST_TYPE.REAL:
        return this._parseRealValue(startOffset, 1 << objInfo);

      case BPLIST_TYPE.DATE:
        return this._parseDateValue(startOffset);

      case BPLIST_TYPE.DATA:
        return this._parseDataValue(startOffset, objLength);

      case BPLIST_TYPE.STRING_ASCII:
        return this._parseAsciiString(startOffset, objLength);

      case BPLIST_TYPE.STRING_UNICODE:
        return this._parseUnicodeString(startOffset, objLength);

      case BPLIST_TYPE.UID:
        return this._parseUidValue(startOffset, objInfo + 1);

      case BPLIST_TYPE.ARRAY:
        return this._createTempArray(objLength, startOffset);

      case BPLIST_TYPE.DICT:
        return this._createTempDict(objLength, startOffset);

      default:
        throw new Error(
          `Unsupported binary plist object type: ${objType.toString(16)}`,
        );
    }
  }

  /**
   * Parses a null type object
   * @param objInfo - The object info
   * @returns The parsed value (null, false, or true)
   */
  _parseNullType(objInfo: number): PlistValue {
    if (objInfo === 0x00) {
      return null;
    } else if (objInfo === 0x08) {
      return false;
    } else if (objInfo === 0x09) {
      return true;
    } else if (objInfo === 0x0f) {
      return null; // fill byte
    }
    return null;
  }

  /**
   * Creates a temporary array object
   * @param objLength - The array length
   * @param startOffset - The start offset
   * @returns The temporary array object
   */
  _createTempArray(objLength: number, startOffset: number): TempObject {
    return {
      type: 'array',
      objLength,
      startOffset,
      value: [] as PlistArray,
    };
  }

  /**
   * Creates a temporary dictionary object
   * @param objLength - The dictionary length
   * @param startOffset - The start offset
   * @returns The temporary dictionary object
   */
  _createTempDict(objLength: number, startOffset: number): TempObject {
    return {
      type: 'dict',
      objLength,
      startOffset,
      value: {} as PlistDictionary,
    };
  }

  /**
   * Type guard to check if an object is a TempObject
   * @param obj - The object to check
   * @returns True if the object is a TempObject
   */
  _isTempObject(obj: ObjectTableItem): obj is TempObject {
    return typeof obj === 'object' && obj !== null && 'type' in obj;
  }

  /**
   * Resolves references for arrays and dictionaries
   */
  _resolveReferences(): void {
    for (let i = 0; i < this._numObjects; i++) {
      const obj = this._objectTable[i];
      if (this._isTempObject(obj)) {
        if (obj.type === 'array') {
          this._resolveArrayReferences(obj, i);
        } else if (obj.type === 'dict') {
          this._resolveDictReferences(obj, i);
        }
      }
    }
  }

  /**
   * Resolves references for an array
   * @param obj - The temporary array object
   * @param index - The index in the object table
   */
  _resolveArrayReferences(obj: TempObject, index: number): void {
    const array = obj.value as PlistArray;
    for (let j = 0; j < obj.objLength; j++) {
      const refIdx = this._readObjectRef(
        obj.startOffset + j * this._objectRefSize,
      );
      const refValue = this._objectTable[refIdx];
      // Ensure we're not adding a TempObject to the array
      if (!this._isTempObject(refValue)) {
        array.push(refValue);
      }
    }
    this._objectTable[index] = array;
  }

  /**
   * Resolves references for a dictionary
   * @param obj - The temporary dictionary object
   * @param index - The index in the object table
   */
  _resolveDictReferences(obj: TempObject, index: number): void {
    const dict = obj.value as PlistDictionary;
    const keyCount = obj.objLength;

    // Keys are stored first, followed by values
    for (let j = 0; j < keyCount; j++) {
      const keyRef = this._readObjectRef(
        obj.startOffset + j * this._objectRefSize,
      );
      const valueRef = this._readObjectRef(
        obj.startOffset + (keyCount + j) * this._objectRefSize,
      );

      const key = this._objectTable[keyRef];
      const value = this._objectTable[valueRef];

      if (typeof key !== 'string') {
        throw new Error(`Dictionary key must be a string, got ${typeof key}`);
      }

      // Ensure we're not adding a TempObject to the dictionary
      if (!this._isTempObject(value)) {
        dict[key] = value;
      }
    }
    this._objectTable[index] = dict;
  }

  /**
   * Handles special case for the top object
   * @returns The final parsed value
   */
  _handleTopObject(): PlistValue {
    // If the top object is an empty object but we have key-value pairs in the array format,
    // convert it to a proper object
    if (
      this._topObject === 0 &&
      this._objectTable[0] &&
      typeof this._objectTable[0] === 'object' &&
      !this._isTempObject(this._objectTable[0]) &&
      Object.keys(this._objectTable[0] as object).length === 0 &&
      this._objectTable.length > 1
    ) {
      return this._convertArrayToDict();
    }

    // Ensure the top object is a PlistValue and not a TempObject
    const topValue = this._objectTable[this._topObject];
    if (this._isTempObject(topValue)) {
      return topValue.value;
    }
    return topValue;
  }

  /**
   * Converts an array format to a dictionary
   * @returns The converted dictionary
   */
  _convertArrayToDict(): PlistDictionary {
    const result: PlistDictionary = {};
    // Process the array in key-value pairs
    for (let i = 1; i < this._objectTable.length; i += 2) {
      const key = this._objectTable[i];
      if (i + 1 < this._objectTable.length && typeof key === 'string') {
        const value = this._objectTable[i + 1];
        if (!this._isTempObject(value)) {
          result[key] = value;
        }
      }
    }
    return result;
  }

  /**
   * Parses the binary plist
   * @returns The parsed JavaScript object
   */
  parse(): PlistValue {
    this._validateHeader();
    this._parseTrailer();
    this._parseObjects();
    this._resolveReferences();
    return this._handleTopObject();
  }
}

/**
 * Parses a binary plist buffer into a JavaScript object
 * @param buffer - The binary plist data as a Buffer
 * @returns The parsed JavaScript object
 */
export function parseBinaryPlist(buffer: Buffer): PlistValue {
  const parser = new BinaryPlistParser(buffer);
  return parser.parse();
}

/**
 * Determines if a buffer is a binary plist
 * @param buffer - The buffer to check
 * @returns True if the buffer is a binary plist
 */
export function isBinaryPlist(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 && buffer.slice(0, 8).equals(BPLIST_MAGIC_AND_VERSION)
  );
}
