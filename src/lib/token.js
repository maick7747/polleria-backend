'use strict';

const crypto = require('crypto');
const env = require('../config/env');

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function signatureFor(content, secret) {
  return encodeBase64Url(crypto.createHmac('sha256', secret).update(content).digest());
}

function signToken(payload, options = {}) {
  const secret = options.secret || env.jwtSecret;
  const ttl = options.expiresInSec || env.tokenTtlSec;
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: issuedAt, exp: issuedAt + ttl };
  const first = encodeBase64Url(JSON.stringify(header));
  const second = encodeBase64Url(JSON.stringify(body));
  const third = signatureFor(`${first}.${second}`, secret);
  return `${first}.${second}.${third}`;
}

function verifyToken(token, secret = env.jwtSecret) {
  if (typeof token !== 'string') {
    throw Object.assign(new Error('Token ausente'), { code: 'UNAUTHORIZED' });
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Token mal formado'), { code: 'UNAUTHORIZED' });
  }

  const [first, second, signature] = parts;
  const expected = signatureFor(`${first}.${second}`, secret);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw Object.assign(new Error('Firma inválida'), { code: 'UNAUTHORIZED' });
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(second));
  } catch (error) {
    throw Object.assign(new Error('Payload inválido'), { code: 'UNAUTHORIZED' });
  }

  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('Payload inválido'), { code: 'UNAUTHORIZED' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Number(payload.exp) <= now) {
    throw Object.assign(new Error('Token expirado'), { code: 'UNAUTHORIZED', expired: true });
  }

  return payload;
}

module.exports = { signToken, verifyToken };
