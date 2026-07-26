import { describe, it, expect } from 'vitest';
import {
  generateAesKey,
  aesEncrypt,
  aesDecrypt,
  uint8ToBase64,
  base64ToUint8,
  rawKeyToHex,
  hexToRawKey,
  encryptForSelf,
  decryptFromSelf,
} from './nostrEncrypt';

describe('nostrEncrypt — base64 + hex codecs', () => {
  it('round-trips arbitrary bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 250, 255]);
    expect(Array.from(base64ToUint8(uint8ToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('round-trips a 32-byte key through hex', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 7 + 3) & 0xff;
    expect(Array.from(hexToRawKey(rawKeyToHex(bytes)))).toEqual(Array.from(bytes));
  });

  it('rejects malformed hex instead of accepting a wrong byte', () => {
    expect(() => hexToRawKey('1g')).toThrow(); // parseInt('1g',16) === 1
    expect(() => hexToRawKey('abc')).toThrow(); // odd length
  });
});

describe('nostrEncrypt — AES-GCM round-trip', () => {
  it('encrypts then decrypts back to the plaintext (incl. unicode)', async () => {
    const { key } = await generateAesKey();
    const msg = 'hello 世界 🔐';
    const ct = await aesEncrypt(key, msg);
    expect(ct).not.toContain('hello');
    expect(await aesDecrypt(key, ct)).toBe(msg);
  });
});

describe('nostrEncrypt — encryptForSelf / decryptFromSelf', () => {
  // Reversible stand-in for a NIP-44 signer (prefix wrap).
  const signer = {
    nip44: {
      encrypt: (_pubkey: string, msg: string) => Promise.resolve(`wrap:${msg}`),
      decrypt: (_pubkey: string, ct: string) => Promise.resolve(ct.replace(/^wrap:/, '')),
    },
  };

  it('round-trips a payload through the self-encryption envelope', async () => {
    const { content, wrappedKey, signerMethod } = await encryptForSelf('{"a":1}', signer, 'pk');
    expect(signerMethod).toBe('nip44');
    expect(await decryptFromSelf(content, wrappedKey, signerMethod, signer, 'pk')).toBe('{"a":1}');
  });

  it('refuses to write when the signer lacks NIP-44 (no silent NIP-04 downgrade)', async () => {
    await expect(encryptForSelf('x', {}, 'pk')).rejects.toThrow(/NIP-44/);
  });
});
