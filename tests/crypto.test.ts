import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { decrypt, deriveKey, encrypt, MAX_VAULT_BYTES, parseEnvelope } from '../server/crypto.js';
import type { VaultSnapshot } from '../shared/types.js';

function changeByte(encoded: string): string {
  const bytes = Buffer.from(encoded, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

function rejectsVault(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => {
    const failure = error as { statusCode?: number; code?: string };
    return failure.statusCode === 400 && failure.code === code;
  });
}

test('real scrypt and AES-256-GCM protect exact Unicode secrets', async t => {
  const password = '  测试主密碼-e\u0301-keep-spaces  ';
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  const keys = [key];
  const timestamp = '2026-01-02T03:04:05.000Z';
  const common = {
    username: '  用户 e\u0301  ', address: 'https://example.invalid', port: '',
    apiKey: '', secret: '', notes: '<script>throw new Error("not executable")</script>',
    createdAt: timestamp, updatedAt: timestamp,
  };
  const vault: VaultSnapshot = {
    revision: 7,
    settings: { autoLockMinutes: 5 },
    entries: [
      { ...common, id: randomUUID(), type: 'account', name: '账户-不应出现在密文', password: '  密码\t漢字-e\u0301\n  ' },
      { ...common, id: randomUUID(), type: 'server', name: '服务器-不应出现在密文', password: '\t  SSH-秘密  \n', port: '65535' },
      { ...common, id: randomUUID(), type: 'api', name: 'API-不应出现在密文', password: '', apiKey: '  key-私密-e\u0301  ', secret: '\n  secret-秘密  \t' },
    ],
  };
  const source = encrypt(vault, key, salt);
  const envelope = parseEnvelope(source);
  try {
    await t.test('round trip preserves all fields without trimming or Unicode normalization', async () => {
      assert.equal(key.length, 32);
      assert.deepEqual(envelope.kdf, { name: 'scrypt', N: 131072, r: 8, p: 1 });
      assert.equal(envelope.cipher, 'aes-256-gcm');
      assert.equal(Buffer.from(envelope.salt, 'base64').length, 16);
      assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
      assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
      const referenceKey = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, derived) => {
          if (error) reject(error);
          else resolve(derived);
        });
      });
      keys.push(referenceKey);
      assert.ok(key.equals(referenceKey), 'key derivation must match native scrypt with the full production cost');
      assert.ok(isDeepStrictEqual(decrypt(envelope, referenceKey), vault), 'decryption must preserve the complete snapshot');
      for (const entry of vault.entries) {
        for (const value of [entry.name, entry.password, entry.apiKey, entry.secret, entry.notes].filter(Boolean)) {
          assert.ok(!source.includes(value), 'encrypted file must not contain plaintext names or secrets');
        }
      }
    });

    await t.test('repeated encryption uses distinct IVs and ciphertexts', () => {
      const second = parseEnvelope(encrypt(vault, key, salt));
      assert.notEqual(second.iv, envelope.iv);
      assert.notEqual(second.ciphertext, envelope.ciphertext);
      assert.notEqual(second.tag, envelope.tag);
      assert.ok(isDeepStrictEqual(decrypt(second, key), vault), 'new IV must still decrypt correctly');
    });

    await t.test('a password with removed surrounding spaces cannot decrypt', async () => {
      const wrongKey = await deriveKey(password.trim(), salt);
      keys.push(wrongKey);
      assert.ok(!key.equals(wrongKey), 'password whitespace is significant');
      rejectsVault(() => decrypt(envelope, wrongKey), 'DECRYPT_FAILED');
    });

    await t.test('GCM rejects modified tags, ciphertext, IVs and authenticated salt', () => {
      for (const field of ['tag', 'ciphertext', 'iv', 'salt'] as const) {
        const modified = parseEnvelope(JSON.stringify({ ...envelope, [field]: changeByte(envelope[field]) }));
        rejectsVault(() => decrypt(modified, key), 'DECRYPT_FAILED');
      }
    });

    await t.test('changed algorithms, format versions and KDF costs are rejected before derivation', () => {
      const changes = [
        { format: 'another-vault' }, { version: 2 }, { cipher: 'aes-256-cbc' },
        { kdf: { ...envelope.kdf, name: 'pbkdf2' } },
        { kdf: { ...envelope.kdf, N: 16384 } },
        { kdf: { ...envelope.kdf, N: 1073741824 } },
        { kdf: { ...envelope.kdf, N: '131072' } },
        { kdf: { ...envelope.kdf, r: 1 } },
        { kdf: { ...envelope.kdf, p: 2 } },
        { kdf: null },
      ];
      for (const change of changes) {
        rejectsVault(() => parseEnvelope(JSON.stringify({ ...envelope, ...change })), 'INVALID_VAULT');
      }
    });
  } finally {
    for (const material of keys) material.fill(0);
  }
});

test('envelope parsing rejects malformed, noncanonical, truncated and oversized files', () => {
  const envelope = {
    format: 'local-password-vault', version: 1,
    kdf: { name: 'scrypt', N: 131072, r: 8, p: 1 },
    salt: Buffer.alloc(16).toString('base64'), cipher: 'aes-256-gcm',
    iv: Buffer.alloc(12).toString('base64'), tag: Buffer.alloc(16).toString('base64'),
    ciphertext: Buffer.from('syntactic ciphertext fixture').toString('base64'),
  };
  for (const source of ['', '{', 'null', '[]', '42', '{}', ' '.repeat(MAX_VAULT_BYTES + 1)]) {
    rejectsVault(() => parseEnvelope(source), 'INVALID_VAULT');
  }
  for (const [field, length] of [['salt', 16], ['iv', 12], ['tag', 16]] as const) {
    for (const value of [null, 42, '', 'not base64!', Buffer.alloc(length - 1).toString('base64'), Buffer.alloc(length + 1).toString('base64')]) {
      rejectsVault(() => parseEnvelope(JSON.stringify({ ...envelope, [field]: value })), 'INVALID_VAULT');
    }
  }
  for (const ciphertext of ['', null, 'AAAA\n', 'Zg', 'Zh==', '@@@@']) {
    rejectsVault(() => parseEnvelope(JSON.stringify({ ...envelope, ciphertext })), 'INVALID_VAULT');
  }
  const { tag: _tag, ...withoutTag } = envelope;
  rejectsVault(() => parseEnvelope(JSON.stringify(withoutTag)), 'INVALID_VAULT');
});
