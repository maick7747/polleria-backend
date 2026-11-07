'use strict';

const crypto = require('crypto');

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) {
    return false;
  }

  const [salt, expected] = stored.split(':');
  const derived = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  const receivedBuffer = Buffer.from(derived);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

module.exports = { hashPassword, verifyPassword };
