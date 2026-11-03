import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadCore, randomBytes } from './helpers.js';

const core = loadCore();
const require = createRequire(import.meta.url);
const sha = (u8) => new Uint8Array(createHash('sha256').update(u8).digest());

// Feeds frames of a stream into a session, dropping each with probability `loss`.
// Returns the number of frames sent when the session finished (or null).
function transfer(enc, { loss = 0.3, seed = 7, maxFrames = 100000, start = 1000 } = {}) {
  const rng = core.makeRng(seed), session = new core.Session(), stream = enc.stream(start);
  for (let sent = 1; sent <= maxFrames; sent++) {
    const f = stream.next();
    if (rng() / 4294967296 < loss) continue;
    session.push(f.bytes);
    if (session.done && session.meta) return { session, sent };
  }
  return { session, sent: null };
}

test('crc32 matches the standard check value', () => {
  assert.equal(core.crc32(new TextEncoder().encode('123456789'), 9), 0xCBF43926);
});

test('pure-JS SHA-256 agrees with node:crypto for awkward lengths', async () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 4097]) {
    const data = randomBytes(n, n + 1);
    assert.deepEqual(core.sha256Js(data), sha(data), `length ${n}`);
  }
  assert.equal(core.hex(core.sha256Js(new TextEncoder().encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256() works with and without WebCrypto', async () => {
  const data = randomBytes(777);
  assert.deepEqual(await core.sha256(data), sha(data));
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try { assert.deepEqual(await core.sha256(data), sha(data)); }
  finally { Object.defineProperty(globalThis, 'crypto', saved); }
  assert.ok(webcrypto);
});

test('packets round-trip and every single-byte corruption is rejected', () => {
  const hash4 = Uint8Array.of(1, 2, 3, 4), payload = randomBytes(40);
  const raw = core.packPacket({ type: 0, size: 1000, blockSize: 40, k: 25, seed: 0xDEADBEEF, hash4, payload });
  const p = core.parsePacket(raw);
  assert.equal(p.size, 1000); assert.equal(p.k, 25); assert.equal(p.seed, 0xDEADBEEF);
  assert.deepEqual(p.hash4, hash4); assert.deepEqual(p.payload, payload);
  for (let i = 0; i < raw.length; i++) {
    const bad = raw.slice(); bad[i] ^= 0x01;
    assert.equal(core.parsePacket(bad), null, `flip in byte ${i}`);
  }
  assert.equal(core.parsePacket(raw.subarray(0, raw.length - 1)), null);
  assert.equal(core.parsePacket(new Uint8Array(0)), null);
});

test('packets whose header contradicts itself are rejected', () => {
  const hash4 = new Uint8Array(4), payload = new Uint8Array(40);
  const wrongK = core.packPacket({ type: 0, size: 1000, blockSize: 40, k: 24, seed: 1, hash4, payload });
  assert.equal(core.parsePacket(wrongK), null);
  const wrongLen = core.packPacket({ type: 0, size: 1000, blockSize: 41, k: 25, seed: 1, hash4, payload });
  assert.equal(core.parsePacket(wrongLen), null);
});

test('metadata keeps unicode names and truncates absurdly long ones', () => {
  const digest = sha(new Uint8Array(1));
  const m = core.decodeMeta(core.encodeMeta({ sha256: digest, name: 'Übung – 数据 🚀.txt', mime: 'text/plain' }));
  assert.equal(m.name, 'Übung – 数据 🚀.txt'); assert.equal(m.mime, 'text/plain');
  assert.deepEqual(m.sha256, digest);
  const long = core.decodeMeta(core.encodeMeta({ sha256: digest, name: 'ä'.repeat(500), mime: 'x/' + 'y'.repeat(500) }));
  assert.ok(new TextEncoder().encode(long.name).length <= 120);
  assert.ok(long.mime.length <= 80);
});

test('degree/neighbour selection is deterministic and well-formed (format stability)', () => {
  for (const k of [1, 2, 3, 10, 100, 1000]) {
    const thr = core.solitonThresholds(k);
    assert.equal(thr[k], 4294967296);
    for (let seed = 0; seed < 300; seed++) {
      const a = core.neighborsOf(seed, k, thr), b = core.neighborsOf(seed, k, thr);
      assert.deepEqual(a, b);
      assert.ok(a.length >= 1 && a.length <= k);
      assert.equal(new Set(a).size, a.length);
      assert.ok(a.every(i => i >= 0 && i < k));
    }
  }
  // Golden values: changing the PRNG or the distribution breaks compatibility between versions.
  const thr = core.solitonThresholds(100);
  assert.deepEqual(core.neighborsOf(1, 100, thr), GOLDEN.s1);
  assert.deepEqual(core.neighborsOf(2, 100, thr), GOLDEN.s2);
  assert.deepEqual(core.neighborsOf(123456789, 100, thr), GOLDEN.s3);
});
const GOLDEN = {
  s1: [24, 40, 91], s2: [89, 6, 35], s3: [99, 51],
};

for (const [size, blockSize] of [
  [0, 600], [1, 600], [2, 1], [599, 600], [600, 600], [601, 600], [1234, 100], [5000, 600],
  [30000, 600], [100000, 600], [100000, 128], [262144, 1000],
]) {
  test(`fountain: ${size} B @ ${blockSize} B blocks survives 30% random frame loss`, async () => {
    const data = randomBytes(size, size + blockSize);
    const enc = await core.Encoder.create(data, { blockSize, name: 'f.bin', mime: 'application/octet-stream' });
    const { session, sent } = transfer(enc, { loss: 0.3, seed: size + 1 });
    assert.ok(sent !== null, 'never completed');
    const res = await session.verify();
    assert.equal(res.level, 'full'); assert.ok(res.ok);
    assert.equal(res.data.length, size);
    assert.deepEqual(res.data, data);                 // byte equality
    assert.equal(session.meta.name, 'f.bin');
  });
}

test('fountain: heavier loss (70%) and a receiver that joins mid-stream still work', async () => {
  const data = randomBytes(20000, 99);
  const enc = await core.Encoder.create(data, { blockSize: 500, name: 'a', mime: '' });
  const stream = enc.stream(424242);
  for (let i = 0; i < 123; i++) stream.next();                     // receiver switches on late
  const rng = core.makeRng(5), session = new core.Session();
  for (let i = 0; i < 20000 && !(session.done && session.meta); i++) {
    const f = stream.next();
    if (rng() / 4294967296 > 0.3) continue;
    session.push(f.bytes);
  }
  assert.ok(session.done);
  assert.deepEqual((await session.verify()).data, data);
});

test('session ignores damaged, duplicate and foreign packets', async () => {
  const a = await core.Encoder.create(randomBytes(3000, 1), { blockSize: 300, name: 'a' });
  const b = await core.Encoder.create(randomBytes(3000, 2), { blockSize: 300, name: 'b' });
  const s = new core.Session();
  assert.equal(s.push(a.dataPacket(5)), 'data');
  assert.equal(s.push(a.dataPacket(5)), 'dup');
  assert.equal(s.push(b.dataPacket(6)), 'foreign');        // different file, same geometry
  const bad = a.dataPacket(7); bad[30] ^= 0xFF;
  assert.equal(s.push(bad), 'invalid');
  assert.equal(s.push(a.metaPacket()), 'meta');
  assert.deepEqual(s.stats, { frames: 3, packets: 1, dups: 1, metaPackets: 1, foreign: 1, invalid: 1 });
});

test('verify() reports a short (32-bit) check when metadata never arrived, and catches corruption', async () => {
  const data = randomBytes(4000, 3);
  const enc = await core.Encoder.create(data, { blockSize: 400, name: 'x' });
  const s = new core.Session();
  for (let seed = 1; !s.done && seed < 500; seed++) s.push(enc.dataPacket(seed));
  assert.ok(s.done && !s.meta);
  const r = await s.verify();
  assert.equal(r.level, 'short'); assert.ok(r.ok);
  s.decoder.blocks[0][0] ^= 1;                              // simulate a bad block
  assert.equal((await s.verify()).ok, false);
});

test('overhead: packets needed vs. K (informational, with sanity bounds)', async () => {
  const rows = [];
  for (const [k, trials] of [[2, 40], [10, 40], [50, 40], [200, 20], [1000, 8], [4000, 3]]) {
    const need = [];
    for (let t = 0; t < trials; t++) {
      const enc = await core.Encoder.create(randomBytes(k * 16, k * 100 + t), { blockSize: 16 });
      const dec = new core.Decoder({ size: enc.size, blockSize: 16, k: enc.k });
      let n = 0;
      for (let seed = t * 7919 + 1; !dec.done && n < k * 5 + 200; seed++, n++) dec.add(seed, core.parsePacket(enc.dataPacket(seed)).payload);
      assert.ok(dec.done, `K=${k} did not finish`);
      need.push(n);
    }
    need.sort((a, b) => a - b);
    const avg = need.reduce((a, b) => a + b, 0) / need.length;
    rows.push({ K: k, avgPackets: avg.toFixed(1), overheadPct: ((avg / k - 1) * 100).toFixed(1), worst: need.at(-1) });
    if (k >= 200) assert.ok(avg / k < 1.25, `K=${k}: ${avg / k}`);
  }
  console.table(rows);
});

test('QR byte mode carries all 256 byte values unchanged (qrcode-generator -> jsQR)', () => {
  const qrcode = require('qrcode-generator'), jsQR = require('jsqr');
  const enc = core.Encoder.prototype;           // only to keep the import honest
  assert.ok(enc);
  for (const ecc of ['L', 'M']) {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const packet = core.packPacket({ type: 0, size: 256, blockSize: 256, k: 1, seed: 1, hash4: new Uint8Array(4), payload: all });
    for (const bytes of [packet, randomBytes(622, 4), randomBytes(1200, 5)]) {
      const qr = qrcode(0, ecc);
      qr.addData(String.fromCharCode(...bytes), 'Byte');
      qr.make();
      const n = qr.getModuleCount(), scale = 4, quiet = 4, side = (n + 2 * quiet) * scale;
      const rgba = new Uint8ClampedArray(side * side * 4).fill(255);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) {
        for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
          const o = (((r + quiet) * scale + y) * side + (c + quiet) * scale + x) * 4;
          rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
        }
      }
      const out = jsQR(rgba, side, side, { inversionAttempts: 'dontInvert' });
      assert.ok(out, `jsQR failed (ecc ${ecc}, ${bytes.length} B)`);
      assert.deepEqual(Uint8Array.from(out.binaryData), bytes);
    }
  }
});
