// The owner's admin login (design §5.4): one password, checked against its scrypt hash; sessions live in Redis.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
// OWASP's minimum for scrypt: N = 2^17, r = 8, p = 1 (128 MiB). Node refuses a cost above maxmem (default 32 MiB).
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_BYTES = 64;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export const hashPassword = (password, salt) => scryptAsync(password, salt, KEY_BYTES, SCRYPT);

export function createAdminAuth({ admin, redis }) {
  return {
    // The new session id, or null for a wrong password.
    async login(password) {
      if (typeof password !== 'string') return null;
      const hash = await hashPassword(password, admin.passwordSalt);
      if (!timingSafeEqual(hash, admin.passwordHash)) return null;
      const id = randomBytes(32).toString('base64url');
      await redis.saveAdminSession(id, admin.sessionTtlSeconds);
      return id;
    },
    isLoggedIn: async (id) => SESSION_ID.test(id ?? '') && redis.adminSessionExists(id),
    logout: (id) => redis.deleteAdminSession(id),
  };
}
