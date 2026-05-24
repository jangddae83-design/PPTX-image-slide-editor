const bufToHex = (buf: Uint8Array): string => 
  Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');

const hexToBuf = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

// Derive cryptographic key from password using PBKDF2
const getDerivationKey = async (password: string): Promise<CryptoKey> => {
  const enc = new TextEncoder();
  return window.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
};

// Derive AES-GCM key from password and salt
const deriveKey = async (passwordKey: CryptoKey, salt: Uint8Array): Promise<CryptoKey> => {
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

/**
 * Encrypts a plain text using AES-GCM-256 and a master password.
 * @param plainText The text to encrypt (e.g. API Key)
 * @param password The master password used for derivation
 * @returns Combined string formatted as "salt:iv:ciphertext" in hex encoding
 */
export const encryptText = async (plainText: string, password: string): Promise<string> => {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  
  const passwordKey = await getDerivationKey(password);
  const aesKey = await deriveKey(passwordKey, salt);
  
  const enc = new TextEncoder();
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    aesKey,
    enc.encode(plainText)
  );
  
  const saltHex = bufToHex(salt);
  const ivHex = bufToHex(iv);
  const ciphertextHex = bufToHex(new Uint8Array(encrypted));
  
  return `${saltHex}:${ivHex}:${ciphertextHex}`;
};

/**
 * Decrypts a hex-encoded cipher text using AES-GCM-256 and a master password.
 * @param encryptedText Text formatted as "salt:iv:ciphertext" in hex encoding
 * @param password The master password used for derivation
 * @returns The decrypted plain text
 * @throws Error if key derivation or decryption fails (e.g. wrong password)
 */
export const decryptText = async (encryptedText: string, password: string): Promise<string> => {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format.');
  }
  
  const salt = hexToBuf(parts[0]);
  const iv = hexToBuf(parts[1]);
  const ciphertext = hexToBuf(parts[2]);
  
  const passwordKey = await getDerivationKey(password);
  const aesKey = await deriveKey(passwordKey, salt);
  
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    aesKey,
    ciphertext
  );
  
  const dec = new TextDecoder();
  return dec.decode(decrypted);
};
