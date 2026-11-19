// Prints the two env lines for the admin login: node src/admin-hash.js (or npm run admin-hash). The password is typed
// without echo and never stored; only its scrypt hash and a random salt are printed.
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from './business/admin-auth.js';

const MIN_LENGTH = 12;

let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
rl.question('Admin password: ', async (password) => {
  rl.close();
  process.stdout.write('\n');
  if (password.length < MIN_LENGTH) {
    console.error(`The password must be at least ${MIN_LENGTH} characters.`);
    process.exitCode = 1;
    return;
  }
  const salt = randomBytes(16);
  console.log(`ADMIN_PASSWORD_HASH=${(await hashPassword(password, salt)).toString('hex')}`);
  console.log(`ADMIN_PASSWORD_SALT=${salt.toString('hex')}`);
});
muted = true;
