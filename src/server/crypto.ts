import crypto from 'crypto';
import { db } from './db.ts';

function getPersistentSessionSecret(): string {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  const row = db
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get('session_secret') as { value: string } | undefined;
  if (row?.value) {
    return row.value;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
    'session_secret',
    generated
  );
  return generated;
}

const SESSION_SECRET = getPersistentSessionSecret();

// Derive stable 32-byte AES-256 key from MASTER_ENCRYPTION_KEY env or deterministic server key
const RAW_ENC_SECRET =
  process.env.MASTER_ENCRYPTION_KEY ||
  process.env.SESSION_SECRET ||
  'bro-radius-local-vault-key-change-in-production';

const AES_KEY = crypto.createHash('sha256').update(RAW_ENC_SECRET).digest();

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return '';
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    AES_KEY,
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const derived = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export interface TokenPayload {
  sub: string;
  ownerId: string;
  email: string;
  name: string;
  networkName: string;
  role: 'admin' | 'accountant' | 'technician' | 'viewer';
  exp: number;
}

export function signToken(payload: Omit<TokenPayload, 'exp'>): string {
  const full: TokenPayload = { ...payload, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 };
  const encoded = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(encoded)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function generateX25519Keypair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  return {
    publicKey: pubDer.subarray(pubDer.length - 32).toString('base64'),
    privateKey: privDer.subarray(privDer.length - 32).toString('base64'),
  };
}
