const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// CRX file format constants
const CRX_MAGIC = 'Cr24';
const CRX_VERSION = 3; // Use version 3 for broader compatibility

// Generate RSA key pair (PEM format for better compatibility)
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
  
  return { publicKey, privateKey };
}

// CRC32 calculation
function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  const table = [];
  
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  
  for (let i = 0; i < buffer.length; i++) {
    crc = table[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  }
  
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Create ZIP file manually
function createZipManual(dirPath) {
  const files = [
    'manifest.json',
    'background.js',
    'content-script.js',
    'popup.html',
    'popup.js',
    'README.md'
  ];
  
  // ZIP format constants
  const LOCAL_HEADER_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const CENTRAL_DIR_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const END_CENTRAL_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  
  const zipData = [];
  let offset = 0;
  
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping missing file: ${file}`);
      continue;
    }
    
    const content = fs.readFileSync(filePath);
    const compressed = zlib.deflateSync(content);
    
    // Create local file header
    const localHeaderSize = 30 + Buffer.byteLength(file) + compressed.length;
    const localHeader = Buffer.alloc(localHeaderSize);
    
    // Local file header
    LOCAL_HEADER_SIG.copy(localHeader, 0); // Signature
    localHeader.writeUInt16LE(20, 4); // Version needed (2.0)
    localHeader.writeUInt16LE(0, 6); // General purpose bit flag
    localHeader.writeUInt16LE(8, 8); // Compression method (deflate)
    localHeader.writeUInt16LE(0, 10); // Last mod time
    localHeader.writeUInt16LE(0, 12); // Last mod date
    localHeader.writeUInt32LE(crc32(content), 14); // CRC-32
    localHeader.writeUInt32LE(compressed.length, 18); // Compressed size
    localHeader.writeUInt32LE(content.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(Buffer.byteLength(file), 26); // File name length
    localHeader.writeUInt16LE(0, 28); // Extra field length
    
    // File name - using toString for explicit encoding
    localHeader.write(file, 30, Buffer.byteLength(file), 'utf8');
    
    // Compressed data
    compressed.copy(localHeader, 30 + Buffer.byteLength(file));
    
    zipData.push({
      name: file,
      data: localHeader,
      content,
      compressed,
      offset
    });
    
    offset += localHeader.length;
  }
  
  // Calculate central directory offset
  let centralDirOffset = offset;
  const centralDirs = [];
  
  for (const entry of zipData) {
    const nameLen = Buffer.byteLength(entry.name);
    const centralDir = Buffer.alloc(46 + nameLen);
    
    CENTRAL_DIR_SIG.copy(centralDir, 0); // Signature
    centralDir.writeUInt16LE(20, 4); // Version made by
    centralDir.writeUInt16LE(20, 6); // Version needed
    centralDir.writeUInt16LE(0, 8); // General purpose bit flag
    centralDir.writeUInt16LE(8, 10); // Compression method
    centralDir.writeUInt16LE(0, 12); // Last mod time
    centralDir.writeUInt16LE(0, 14); // Last mod date
    centralDir.writeUInt32LE(crc32(entry.content), 16); // CRC-32
    centralDir.writeUInt32LE(entry.compressed.length, 20); // Compressed size
    centralDir.writeUInt32LE(entry.content.length, 24); // Uncompressed size
    centralDir.writeUInt16LE(nameLen, 28); // File name length
    centralDir.writeUInt16LE(0, 30); // Extra field length
    centralDir.writeUInt16LE(0, 32); // File comment length
    centralDir.writeUInt16LE(0, 34); // Disk number start
    centralDir.writeUInt16LE(0, 36); // Internal file attributes
    centralDir.writeUInt32LE(0, 38); // External file attributes
    centralDir.writeUInt32LE(entry.offset, 42); // Relative offset of local header
    
    // File name in central directory
    centralDir.write(entry.name, 46, nameLen, 'utf8');
    
    centralDirs.push(centralDir);
  }
  
  // End of central directory
  const endCentral = Buffer.alloc(22);
  END_CENTRAL_SIG.copy(endCentral, 0); // Signature
  endCentral.writeUInt16LE(0, 4); // Disk number
  endCentral.writeUInt16LE(0, 6); // Disk number with central directory
  endCentral.writeUInt16LE(centralDirs.length, 8); // Number of entries on disk
  endCentral.writeUInt16LE(centralDirs.length, 10); // Total number of entries
  
  let centralDirSize = 0;
  for (const cd of centralDirs) {
    centralDirSize += cd.length;
  }
  endCentral.writeUInt32LE(centralDirSize, 12); // Size of central directory
  endCentral.writeUInt32LE(centralDirOffset, 16); // Offset of central directory
  endCentral.writeUInt16LE(0, 20); // Comment length
  
  // Combine all parts
  const zipBuffer = Buffer.concat([
    ...zipData.map(e => e.data),
    ...centralDirs,
    endCentral
  ]);
  
  return zipBuffer;
}

// Convert PEM public key to DER format (SPKI)
function pemToDer(pem) {
  // Remove PEM headers and decode base64
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  return Buffer.from(base64, 'base64');
}

// Create CRX file
function createCRX(extensionDir, outputPath) {
  console.log('Generating RSA key pair...');
  const { publicKey, privateKey } = generateKeyPair();
  
  console.log('Creating ZIP file...');
  const zipData = createZipManual(extensionDir);
  
  console.log('Signing ZIP data...');
  
  // Sign the data using PEM format private key
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(zipData);
  const signature = signer.sign(privateKey);
  
  // Convert public key to DER format for CRX header
  const publicKeyDer = pemToDer(publicKey);
  
  // CRX header
  const publicKeyLength = publicKeyDer.length;
  const signatureLength = signature.length;
  const headerLength = 16 + publicKeyLength + signatureLength;
  
  const header = Buffer.alloc(headerLength);
  let offset = 0;
  
  // Magic number
  header.write(CRX_MAGIC, offset);
  offset += 4;
  
  // Version
  header.writeUInt32LE(CRX_VERSION, offset);
  offset += 4;
  
  // Header length
  header.writeUInt32LE(headerLength - 12, offset);
  offset += 4;
  
  // Public key (DER format)
  publicKeyDer.copy(header, offset);
  offset += publicKeyLength;
  
  // Signature
  signature.copy(header, offset);
  
  // Combine header and ZIP data
  const crxData = Buffer.concat([header, zipData]);
  
  // Write CRX file
  fs.writeFileSync(outputPath, crxData);
  
  // Save the private key for future use
  const keyPath = outputPath.replace('.crx', '.key');
  fs.writeFileSync(keyPath, privateKey);
  
  console.log(`CRX file created: ${outputPath}`);
  console.log(`Private key saved: ${keyPath}`);
  
  return { crxPath: outputPath, keyPath };
}

// Main execution
const extensionDir = __dirname;
const outputCRX = path.join(__dirname, 'ChatGPT-Auto-Dictate.crx');

createCRX(extensionDir, outputCRX);
