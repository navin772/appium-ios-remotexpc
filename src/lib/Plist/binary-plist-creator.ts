/**
 * Binary Property List (bplist) Creator
 * 
 * This module provides functionality to create binary property lists (bplists)
 * commonly used in Apple's iOS and macOS systems.
 */

// Constants for binary plist format
const BPLIST_MAGIC = 'bplist';
const BPLIST_VERSION = '00';
const BPLIST_MAGIC_AND_VERSION = Buffer.from(`${BPLIST_MAGIC}${BPLIST_VERSION}`);

// Object types in binary plist
const BPLIST_TYPE = {
  NULL: 0x00,
  FALSE: 0x08,
  TRUE: 0x09,
  FILL: 0x0F,
  INT: 0x10,
  REAL: 0x20,
  DATE: 0x30,
  DATA: 0x40,
  STRING_ASCII: 0x50,
  STRING_UNICODE: 0x60,
  UID: 0x80,
  ARRAY: 0xA0,
  SET: 0xC0,
  DICT: 0xD0
};

/**
 * Creates a binary plist from a JavaScript object
 * @param obj - The JavaScript object to convert to a binary plist
 * @returns Buffer containing the binary plist data
 */
export function createBinaryPlist(obj: any): Buffer {
  // Collect all objects and assign IDs
  const objectTable: any[] = [];
  const objectRefMap = new Map<any, number>();
  
  // Collect all unique objects
  function collectObjects(value: any): void {
    // Skip if already in the table
    if (objectRefMap.has(value)) {
      return;
    }
    
    // Add to the table and map
    const id = objectTable.length;
    objectTable.push(value);
    objectRefMap.set(value, id);
    
    // Recursively collect objects for arrays and dictionaries
    if (Array.isArray(value)) {
      for (const item of value) {
        collectObjects(item);
      }
    } else if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
      for (const key of Object.keys(value)) {
        collectObjects(key);
        collectObjects(value[key]);
      }
    }
  }
  
  collectObjects(obj);
  
  // Calculate sizes
  const numObjects = objectTable.length;
  const objectRefSize = calculateMinByteSize(numObjects - 1);
  
  // Create object data
  const objectOffsets: number[] = [];
  const objectData: Buffer[] = [];
  
  for (const value of objectTable) {
    objectOffsets.push(calculateObjectDataLength(objectData));
    objectData.push(createObjectData(value, objectRefMap, objectRefSize));
  }
  
  // Calculate offset table size
  const maxOffset = calculateObjectDataLength(objectData);
  const offsetSize = calculateMinByteSize(maxOffset);
  
  // Create offset table
  const offsetTable = Buffer.alloc(numObjects * offsetSize);
  for (let i = 0; i < numObjects; i++) {
    writeOffsetToBuffer(offsetTable, i * offsetSize, objectOffsets[i], offsetSize);
  }
  
  // Create trailer
  const trailer = Buffer.alloc(32);
  // 6 unused bytes
  trailer.fill(0, 0, 6);
  // offset size (1 byte)
  trailer.writeUInt8(offsetSize, 6);
  // object ref size (1 byte)
  trailer.writeUInt8(objectRefSize, 7);
  // number of objects (8 bytes)
  writeBigIntToBuffer(trailer, 8, BigInt(numObjects));
  // top object ID (8 bytes)
  writeBigIntToBuffer(trailer, 16, BigInt(0)); // Root object is always the first one
  // offset table offset (8 bytes)
  const offsetTableOffset = BPLIST_MAGIC_AND_VERSION.length + calculateObjectDataLength(objectData);
  writeBigIntToBuffer(trailer, 24, BigInt(offsetTableOffset));
  
  // Combine all parts
  return Buffer.concat([
    BPLIST_MAGIC_AND_VERSION,
    ...objectData,
    offsetTable,
    trailer
  ]);
}

/**
 * Calculates the minimum number of bytes needed to represent a number
 * @param value - The number to calculate for
 * @returns The minimum number of bytes needed (1, 2, 4, or 8)
 */
function calculateMinByteSize(value: number): number {
  if (value < 256) {
    return 1;
  } else if (value < 65536) {
    return 2;
  } else if (value < 4294967296) {
    return 4;
  } else {
    return 8;
  }
}

/**
 * Calculates the total length of object data buffers
 * @param buffers - Array of buffers
 * @returns Total length
 */
function calculateObjectDataLength(buffers: Buffer[]): number {
  return buffers.reduce((sum, buffer) => sum + buffer.length, 0);
}

/**
 * Writes an offset value to a buffer
 * @param buffer - Target buffer
 * @param position - Position in the buffer
 * @param value - Value to write
 * @param size - Number of bytes to use
 */
function writeOffsetToBuffer(buffer: Buffer, position: number, value: number, size: number): void {
  if (size === 1) {
    buffer.writeUInt8(value, position);
  } else if (size === 2) {
    buffer.writeUInt16BE(value, position);
  } else if (size === 4) {
    buffer.writeUInt32BE(value, position);
  } else if (size === 8) {
    buffer.writeBigUInt64BE(BigInt(value), position);
  }
}

/**
 * Writes a BigInt to a buffer
 * @param buffer - Target buffer
 * @param position - Position in the buffer
 * @param value - BigInt value to write
 */
function writeBigIntToBuffer(buffer: Buffer, position: number, value: bigint): void {
  buffer.writeBigUInt64BE(value, position);
}

/**
 * Creates binary data for an object
 * @param value - The value to convert
 * @param objectRefMap - Map of objects to their IDs
 * @param objectRefSize - Size of object references in bytes
 * @returns Buffer containing the binary data
 */
function createObjectData(value: any, objectRefMap: Map<any, number>, objectRefSize: number): Buffer {
  // Handle null and booleans
  if (value === null) {
    return Buffer.from([BPLIST_TYPE.NULL]);
  } else if (value === false) {
    return Buffer.from([BPLIST_TYPE.FALSE]);
  } else if (value === true) {
    return Buffer.from([BPLIST_TYPE.TRUE]);
  }
  
  // Handle numbers
  if (typeof value === 'number') {
    // Check if it's an integer
    if (Number.isInteger(value)) {
      // Determine the smallest representation
      if (value >= 0 && value <= 255) {
        const buffer = Buffer.alloc(2);
        buffer.writeUInt8(BPLIST_TYPE.INT | 0, 0);
        buffer.writeUInt8(value, 1);
        return buffer;
      } else if (value >= -128 && value <= 127) {
        const buffer = Buffer.alloc(2);
        buffer.writeUInt8(BPLIST_TYPE.INT | 0, 0);
        buffer.writeInt8(value, 1);
        return buffer;
      } else if (value >= -32768 && value <= 32767) {
        const buffer = Buffer.alloc(3);
        buffer.writeUInt8(BPLIST_TYPE.INT | 1, 0);
        buffer.writeInt16BE(value, 1);
        return buffer;
      } else if (value >= -2147483648 && value <= 2147483647) {
        const buffer = Buffer.alloc(5);
        buffer.writeUInt8(BPLIST_TYPE.INT | 2, 0);
        buffer.writeInt32BE(value, 1);
        return buffer;
      } else {
        // 64-bit integer
        const buffer = Buffer.alloc(9);
        buffer.writeUInt8(BPLIST_TYPE.INT | 3, 0);
        buffer.writeBigInt64BE(BigInt(value), 1);
        return buffer;
      }
    } else {
      // Float
      const buffer = Buffer.alloc(9);
      buffer.writeUInt8(BPLIST_TYPE.REAL | 3, 0); // Use double precision
      buffer.writeDoubleBE(value, 1);
      return buffer;
    }
  }
  
  // Handle Date
  if (value instanceof Date) {
    const buffer = Buffer.alloc(9);
    buffer.writeUInt8(BPLIST_TYPE.DATE, 0);
    // Convert to seconds since Apple epoch (2001-01-01)
    const APPLE_EPOCH_OFFSET = 978307200; // Seconds between 1970 and 2001
    const timestamp = value.getTime() / 1000 - APPLE_EPOCH_OFFSET;
    buffer.writeDoubleBE(timestamp, 1);
    return buffer;
  }
  
  // Handle Buffer (DATA)
  if (Buffer.isBuffer(value)) {
    const length = value.length;
    let header: Buffer;
    
    if (length < 15) {
      header = Buffer.from([BPLIST_TYPE.DATA | length]);
    } else {
      // For longer data, we need to encode the length separately
      const lengthBuffer = createIntHeader(length);
      header = Buffer.concat([
        Buffer.from([BPLIST_TYPE.DATA | 0x0F]), // 0x0F indicates length follows
        lengthBuffer
      ]);
    }
    
    return Buffer.concat([header, value]);
  }
  
  // Handle strings
  if (typeof value === 'string') {
    // Check if string can be ASCII
    const isAscii = /^[\x00-\x7F]*$/.test(value);
    const stringBuffer = isAscii 
      ? Buffer.from(value, 'ascii')
      : Buffer.from(value, 'utf16le');
    
    const length = isAscii ? value.length : value.length;
    let header: Buffer;
    
    if (length < 15) {
      header = Buffer.from([isAscii ? (BPLIST_TYPE.STRING_ASCII | length) : (BPLIST_TYPE.STRING_UNICODE | length)]);
    } else {
      // For longer strings, we need to encode the length separately
      const lengthBuffer = createIntHeader(length);
      header = Buffer.concat([
        Buffer.from([isAscii ? (BPLIST_TYPE.STRING_ASCII | 0x0F) : (BPLIST_TYPE.STRING_UNICODE | 0x0F)]),
        lengthBuffer
      ]);
    }
    
    return Buffer.concat([header, stringBuffer]);
  }
  
  // Handle arrays
  if (Array.isArray(value)) {
    const length = value.length;
    let header: Buffer;
    
    if (length < 15) {
      header = Buffer.from([BPLIST_TYPE.ARRAY | length]);
    } else {
      // For longer arrays, we need to encode the length separately
      const lengthBuffer = createIntHeader(length);
      header = Buffer.concat([
        Buffer.from([BPLIST_TYPE.ARRAY | 0x0F]), // 0x0F indicates length follows
        lengthBuffer
      ]);
    }
    
    // Create references to each item
    const refBuffer = Buffer.alloc(length * objectRefSize);
    for (let i = 0; i < length; i++) {
      const itemRef = objectRefMap.get(value[i]) ?? 0;
      writeOffsetToBuffer(refBuffer, i * objectRefSize, itemRef, objectRefSize);
    }
    
    return Buffer.concat([header, refBuffer]);
  }
  
  // Handle objects (dictionaries)
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const length = keys.length;
    let header: Buffer;
    
    if (length < 15) {
      header = Buffer.from([BPLIST_TYPE.DICT | length]);
    } else {
      // For larger dictionaries, we need to encode the length separately
      const lengthBuffer = createIntHeader(length);
      header = Buffer.concat([
        Buffer.from([BPLIST_TYPE.DICT | 0x0F]), // 0x0F indicates length follows
        lengthBuffer
      ]);
    }
    
    // Create references to keys and values
    const keyRefBuffer = Buffer.alloc(length * objectRefSize);
    const valueRefBuffer = Buffer.alloc(length * objectRefSize);
    
    for (let i = 0; i < length; i++) {
      const key = keys[i];
      const keyRef = objectRefMap.get(key) ?? 0;
      const valueRef = objectRefMap.get(value[key]) ?? 0;
      
      writeOffsetToBuffer(keyRefBuffer, i * objectRefSize, keyRef, objectRefSize);
      writeOffsetToBuffer(valueRefBuffer, i * objectRefSize, valueRef, objectRefSize);
    }
    
    return Buffer.concat([header, keyRefBuffer, valueRefBuffer]);
  }
  
  // Default fallback
  return Buffer.from([BPLIST_TYPE.NULL]);
}

/**
 * Creates a header for an integer value
 * @param value - The integer value
 * @returns Buffer containing the integer header
 */
function createIntHeader(value: number): Buffer {
  if (value < 256) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt8(BPLIST_TYPE.INT | 0, 0);
    buffer.writeUInt8(value, 1);
    return buffer;
  } else if (value < 65536) {
    const buffer = Buffer.alloc(3);
    buffer.writeUInt8(BPLIST_TYPE.INT | 1, 0);
    buffer.writeUInt16BE(value, 1);
    return buffer;
  } else {
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(BPLIST_TYPE.INT | 2, 0);
    buffer.writeUInt32BE(value, 1);
    return buffer;
  }
}

export default createBinaryPlist;
