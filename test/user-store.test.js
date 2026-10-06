'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { userData: fixtureRoot, loadModule, createMemoryFs } = require('./helpers/harness');

function setup() {
  const mem = createMemoryFs();
  const fs = Object.assign(mem.fs, {
    calls: mem.calls,
    addFile: mem.set,
    peek: mem.content,
    count: (method) => mem.calls.filter((call) => call.method === method).length
  });
  const api = loadModule('store/user-store.js', { requires: { fs } });
  const dir = path.join(fixtureRoot, 'users');
  const file = path.join(dir, 'users.json');
  const store = new api.LocalUserStore(dir);
  return { ...api, fs, dir, file, store,
    seed: (data) => fs.addFile(file, typeof data === 'string' ? data : JSON.stringify(data)),
    stored: () => JSON.parse(fs.peek(file)) };
}

const input = { username: '  Tester  ', email: '  TESTER@EXAMPLE.INVALID ', password: 'synthetic-password' };

test('hashPassword uses a random 16-byte salt and a 64-byte scrypt hash', () => {
  const { hashPassword, verifyPassword } = setup();
  const first = hashPassword('password');
  const second = hashPassword('password');
  assert.match(first, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.notEqual(first, second);
  const [salt, hash] = first.split(':');
  assert.equal(hash, crypto.scryptSync('password', salt, 64).toString('hex'));
  assert.equal(verifyPassword('password', first), true);
  assert.equal(verifyPassword('password', second), true);
});

test('password verification rejects a wrong password and malformed stored hashes', () => {
  const { hashPassword, verifyPassword } = setup();
  const hash = hashPassword('right');
  assert.equal(verifyPassword('wrong', hash), false);
  for (const malformed of [undefined, null, '', 'no-colon', 'salt:bad', 'salt:00', {}]) {
    assert.equal(verifyPassword('right', malformed), false);
  }
});

test('password hashing supports empty and Unicode passwords consistently', () => {
  const { hashPassword, verifyPassword } = setup();
  for (const password of ['', '中文密码-test']) {
    const hash = hashPassword(password);
    assert.equal(verifyPassword(password, hash), true);
    assert.equal(verifyPassword(password + 'x', hash), false);
  }
});

test('sanitizeUser removes only passwordHash and leaves its input untouched', () => {
  const { sanitizeUser } = setup();
  const original = { id: 'u1', username: 'test', passwordHash: 'private-hash', avatarColor: '#123456' };
  assert.deepEqual(sanitizeUser(original), { id: 'u1', username: 'test', avatarColor: '#123456' });
  assert.equal(original.passwordHash, 'private-hash');
  assert.equal(sanitizeUser(null), null);
  assert.equal(sanitizeUser(undefined), null);
});

test('missing, corrupt or non-array user data initializes an empty store', () => {
  const h = setup();
  assert.deepEqual(h.store.data, { users: [] });
  h.seed('{bad');
  assert.deepEqual(new h.LocalUserStore(h.dir).data, { users: [] });
  h.seed({ users: 'invalid', formatVersion: 1 });
  assert.deepEqual(new h.LocalUserStore(h.dir).data, { users: [], formatVersion: 1 });
});

test('createUser trims username, normalizes email and persists only a hash', () => {
  const h = setup();
  const user = h.store.createUser(input);
  assert.equal(user.username, 'Tester');
  assert.equal(user.email, 'tester@example.invalid');
  assert.match(user.id, /^u_[a-z0-9]+$/);
  assert.equal(typeof user.createdAt, 'number');
  assert.equal(Object.hasOwn(user, 'passwordHash'), false);
  assert.equal(h.fs.peek(h.file).includes(input.password), false);
  const record = h.stored().users[0];
  assert.equal(h.verifyPassword(input.password, record.passwordHash), true);
  assert.equal(Object.hasOwn(record, 'password'), false);
  assert.deepEqual(h.fs.calls.find((c) => c.method === 'mkdirSync').args, [h.dir, { recursive: true }]);
});

test('independent store instances reload before creating and preserve existing users', () => {
  const h = setup();
  const other = new h.LocalUserStore(h.dir);
  const first = h.store.createUser(input);
  const second = other.createUser({ username: 'Second', email: 'second@example.invalid', password: 'second' });
  assert.notEqual(first.id, second.id);
  assert.equal(h.stored().users.length, 2);
  assert.deepEqual(h.store.getUser(second.id), second);
});

test('username lookup trims whitespace and preserves case-sensitive identity', () => {
  const h = setup();
  h.seed({ users: [{ id: 'u1', username: 'Tester', email: 'tester@example.invalid', passwordHash: 'hash' }] });
  assert.equal(h.store.findByUsername(' Tester ').id, 'u1');
  assert.equal(h.store.findByUsername('tester'), null);
  assert.equal(h.store.findByUsername('missing'), null);
});

test('email lookup trims whitespace and ignores letter case', () => {
  const h = setup();
  h.seed({ users: [{ id: 'u1', username: 'Tester', email: 'tester@example.invalid' }] });
  assert.equal(h.store.findByEmail(' TESTER@EXAMPLE.INVALID ').id, 'u1');
  assert.equal(h.store.findByEmail('missing@example.invalid'), null);
});

test('store-level password verification delegates to the stored hash', () => {
  const h = setup();
  h.store.createUser(input);
  const user = h.store.findByUsername('Tester');
  assert.equal(h.store.verifyPassword(user, input.password), true);
  assert.equal(h.store.verifyPassword(user, 'wrong'), false);
});

test('updateUser changes supported profile fields and protects identity and credentials', () => {
  const h = setup();
  const user = h.store.createUser(input);
  const hash = h.stored().users[0].passwordHash;
  const updated = h.store.updateUser(user.id, { username: ' Renamed ', email: ' NEW@EXAMPLE.INVALID ',
    avatarColor: '#aabbcc', id: 'forged', passwordHash: 'forged', createdAt: 0, password: 'forged' });
  assert.equal(updated.username, 'Renamed');
  assert.equal(updated.email, 'new@example.invalid');
  assert.equal(updated.avatarColor, '#aabbcc');
  assert.equal(updated.id, user.id);
  assert.equal(updated.createdAt, user.createdAt);
  assert.equal(Object.hasOwn(updated, 'passwordHash'), false);
  assert.equal(h.stored().users[0].passwordHash, hash);
  assert.equal(h.store.findByUsername('Tester'), null);
  assert.equal(h.store.findByEmail('new@example.invalid').id, user.id);
});

test('partial profile updates preserve omitted fields and can intentionally clear fields', () => {
  const h = setup();
  const user = h.store.createUser(input);
  const partial = h.store.updateUser(user.id, { avatarColor: null });
  assert.equal(partial.username, 'Tester');
  assert.equal(partial.email, 'tester@example.invalid');
  assert.equal(partial.avatarColor, null);
  const cleared = h.store.updateUser(user.id, { username: '', email: '' });
  assert.equal(cleared.username, '');
  assert.equal(cleared.email, '');
});

test('updating or reading an unknown user returns null without writing', () => {
  const h = setup();
  assert.equal(h.store.updateUser('missing', { username: 'test' }), null);
  assert.equal(h.store.getUser('missing'), null);
  assert.equal(h.fs.count('writeFileSync'), 0);
});

test('getUser returns a sanitized copy and reloads externally changed data', () => {
  const h = setup();
  h.seed({ users: [{ id: 'u1', username: 'one', passwordHash: 'hash' }] });
  const first = h.store.getUser('u1');
  first.username = 'caller-edit';
  assert.equal(h.store.getUser('u1').username, 'one');
  h.seed({ users: [{ id: 'u1', username: 'external', passwordHash: 'hash' }] });
  assert.equal(h.store.getUser('u1').username, 'external');
  assert.equal(Object.hasOwn(h.store.getUser('u1'), 'passwordHash'), false);
});

test('persistence failures propagate from user creation', () => {
  const h = setup();
  h.fs.writeFileSync = () => { throw new Error('disk full'); };
  assert.throws(() => h.store.createUser(input), /disk full/);
});

test('CloudUserStore fails explicitly while the implementation is unavailable', () => {
  const h = setup();
  assert.throws(() => new h.CloudUserStore({}), /尚未启用/);
});
