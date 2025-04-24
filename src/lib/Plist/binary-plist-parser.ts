/**
 * Binary Property List (bplist) Parser
 * 
 * This module provides functionality to parse binary property lists (bplists)
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
 * Parses a binary plist buffer into a JavaScript object
 * @param buffer - The binary plist data as a Buffer
 * @returns The parsed JavaScript object
 */
export function parseBinaryPlist(buffer: Buffer): any {
  // Check magic number and version
  if (buffer.length < 8 || !buffer.slice(0, 8).equals(BPLIST_MAGIC_AND_VERSION)) {
    throw new Error('Not a binary plist. Expected bplist00 magic.');
  }

  // Parse trailer
  const trailerSize = 32; // Last 32 bytes are the trailer
  if (buffer.length < trailerSize) {
    throw new Error('Binary plist is too small to contain a trailer.');
  }

  const trailer = buffer.slice(buffer.length - trailerSize);
  
  // Extract trailer information
  const offsetSize = trailer.readUInt8(6);
  const objectRefSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));

  // Create object table
  const objectTable: any[] = [];
  
  // Function to read an object reference
  const readObjectRef = (offset: number): number => {
    let result = 0;
    for (let i = 0; i < objectRefSize; i++) {
      result = (result << 8) | buffer.readUInt8(offset + i);
    }
    return result;
  };

  // Function to read an offset from the offset table
  const readOffset = (index: number): number => {
    const offsetStart = offsetTableOffset + (index * offsetSize);
    let result = 0;
    for (let i = 0; i < offsetSize; i++) {
      result = (result << 8) | buffer.readUInt8(offsetStart + i);
    }
    return result;
  };

  // Parse all objects
  for (let i = 0; i < numObjects; i++) {
    const objOffset = readOffset(i);
    const objType = buffer.readUInt8(objOffset) & 0xF0;
    const objInfo = buffer.readUInt8(objOffset) & 0x0F;
    
    let objLength = objInfo;
    let startOffset = objOffset + 1;
    
    // For objects with length > 15, the actual length follows
    if (objInfo === 0x0F) {
      const intType = buffer.readUInt8(startOffset) & 0xF0;
      if (intType !== BPLIST_TYPE.INT) {
        throw new Error(`Expected integer type for length at offset ${startOffset}`);
      }
      
      const intInfo = buffer.readUInt8(startOffset) & 0x0F;
      startOffset++;
      
      // Read the length based on the integer size
      objLength = 0;
      const intByteCount = 1 << intInfo;
      for (let j = 0; j < intByteCount; j++) {
        objLength = (objLength << 8) | buffer.readUInt8(startOffset + j);
      }
      startOffset += intByteCount;
    }
    
    // Parse the object based on its type
    let parsedObj;
    
    switch (objType) {
      case BPLIST_TYPE.NULL:
        if (objInfo === 0x00) {
          parsedObj = null;
        } else if (objInfo === 0x08) {
          parsedObj = false;
        } else if (objInfo === 0x09) {
          parsedObj = true;
        } else if (objInfo === 0x0F) {
          parsedObj = null; // fill byte
        }
        break;
        
      case BPLIST_TYPE.INT:
        {
          const intByteCount = 1 << objInfo;
          let intValue = 0;
          
          // Handle different integer sizes
          if (intByteCount === 1) {
            intValue = buffer.readInt8(startOffset);
          } else if (intByteCount === 2) {
            intValue = buffer.readInt16BE(startOffset);
          } else if (intByteCount === 4) {
            intValue = buffer.readInt32BE(startOffset);
          } else if (intByteCount === 8) {
            // For 64-bit integers, we need to handle potential precision loss
            const bigInt = buffer.readBigInt64BE(startOffset);
            intValue = Number(bigInt);
            // Check if conversion to Number caused precision loss
            if (BigInt(intValue) !== bigInt) {
              console.warn('Precision loss when converting 64-bit integer to Number');
            }
          }
          
          parsedObj = intValue;
        }
        break;
        
      case BPLIST_TYPE.REAL:
        {
          const floatByteCount = 1 << objInfo;
          
          if (floatByteCount === 4) {
            parsedObj = buffer.readFloatBE(startOffset);
          } else if (floatByteCount === 8) {
            parsedObj = buffer.readDoubleBE(startOffset);
          }
        }
        break;
        
      case BPLIST_TYPE.DATE:
        {
          // Date is stored as a float, seconds since 2001-01-01
          const timestamp = buffer.readDoubleBE(startOffset);
          // Convert Apple epoch (2001-01-01) to Unix epoch (1970-01-01)
          const APPLE_EPOCH_OFFSET = 978307200; // Seconds between 1970 and 2001
          parsedObj = new Date((timestamp + APPLE_EPOCH_OFFSET) * 1000);
        }
        break;
        
      case BPLIST_TYPE.DATA:
        parsedObj = Buffer.from(buffer.slice(startOffset, startOffset + objLength));
        break;
        
      case BPLIST_TYPE.STRING_ASCII:
        parsedObj = buffer.slice(startOffset, startOffset + objLength).toString('ascii');
        break;
        
      case BPLIST_TYPE.STRING_UNICODE:
        {
          // Unicode strings are stored as UTF-16BE
          const utf16Buffer = Buffer.alloc(objLength * 2);
          for (let j = 0; j < objLength; j++) {
            utf16Buffer.writeUInt16BE(buffer.readUInt16BE(startOffset + j * 2), j * 2);
          }
          parsedObj = utf16Buffer.toString('utf16le', 0, objLength * 2);
        }
        break;
        
      case BPLIST_TYPE.UID:
        {
          const uidByteCount = objInfo + 1;
          let uidValue = 0;
          for (let j = 0; j < uidByteCount; j++) {
            uidValue = (uidValue << 8) | buffer.readUInt8(startOffset + j);
          }
          parsedObj = uidValue;
        }
        break;
        
      case BPLIST_TYPE.ARRAY:
        {
          parsedObj = [] as any[];
          const arrayStartOffset = startOffset + (objLength * objectRefSize);
          
          // We'll need to resolve references later
          objectTable.push({
            type: 'array',
            objLength,
            startOffset,
            value: parsedObj
          });
        }
        break;
        
      case BPLIST_TYPE.DICT:
        {
          parsedObj = {};
          
          // We'll need to resolve references later
          objectTable.push({
            type: 'dict',
            objLength,
            startOffset,
            value: parsedObj
          });
        }
        break;
        
      default:
        throw new Error(`Unsupported binary plist object type: ${objType.toString(16)}`);
    }
    
    objectTable[i] = parsedObj;
  }
  
  // Resolve references for arrays and dictionaries
  for (let i = 0; i < numObjects; i++) {
    const obj = objectTable[i];
    if (typeof obj === 'object' && obj !== null && 'type' in obj) {
      if (obj.type === 'array') {
        const array = obj.value;
        for (let j = 0; j < obj.objLength; j++) {
          const refIdx = readObjectRef(obj.startOffset + j * objectRefSize);
          array.push(objectTable[refIdx]);
        }
        objectTable[i] = array;
      } else if (obj.type === 'dict') {
        const dict = obj.value;
        const keyCount = obj.objLength;
        
        // Keys are stored first, followed by values
        for (let j = 0; j < keyCount; j++) {
          const keyRef = readObjectRef(obj.startOffset + j * objectRefSize);
          const valueRef = readObjectRef(obj.startOffset + (keyCount + j) * objectRefSize);
          
          const key = objectTable[keyRef];
          const value = objectTable[valueRef];
          
          if (typeof key !== 'string') {
            throw new Error(`Dictionary key must be a string, got ${typeof key}`);
          }
          
          dict[key] = value;
        }
        objectTable[i] = dict;
      }
    }
  }
  
  // If the top object is an empty object but we have key-value pairs in the array format,
  // convert it to a proper object
  if (topObject === 0 && Object.keys(objectTable[0]).length === 0 && objectTable.length > 1) {
    const result: Record<string, any> = {};
    // Process the array in key-value pairs
    for (let i = 1; i < objectTable.length; i += 2) {
      if (i + 1 < objectTable.length && typeof objectTable[i] === 'string') {
        result[objectTable[i]] = objectTable[i + 1];
      }
    }
    return result;
  }

  return objectTable[topObject];
}

/**
 * Determines if a buffer is a binary plist
 * @param buffer - The buffer to check
 * @returns True if the buffer is a binary plist
 */
export function isBinaryPlist(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer.slice(0, 8).equals(BPLIST_MAGIC_AND_VERSION)
  );
}
