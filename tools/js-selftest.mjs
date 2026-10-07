// SPDX-License-Identifier: GPL-2.0-or-later
//
// Tests protocol.js against REAL frames captured from the device.
// Needs no hardware, GNOME or gjs:  node tools/js-selftest.mjs
// (also runs as gjs -m tools/js-selftest.mjs — it only uses console.log.)

import * as P from '../src/inzone@soylu.me/protocol.js';

let fails = 0;
const ok = (label, cond, detail = '') => {
    console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${cond || !detail ? '' : `  <- ${detail}`}`);
    if (!cond)
        fails++;
};
const hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');
const bytes = s => Uint8Array.from(s.split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)));

console.log('1) buildCommand — a REAL SET frame sent to the device');
// The raw bytes query.py printed:
//   SET NOISE_CONTROL(0x41) tid=2 payload=00 14 ff 00
const real = '02 10 01 00 fc 0c 96 c3 41 41 02 02 00 00 14 ff 00 f2';
const built = P.buildCommand(P.ADDR_PC_TO_RX, P.EV.NOISE, P.SET, 2, [0x00, 0x14, 0xff, 0x00]);
ok('identical byte for byte', hex(built.slice(0, 18)) === real, hex(built.slice(0, 18)));
ok('checksum 0xf2', built[17] === 0xf2, `0x${built[17].toString(16)}`);
ok('report is 64 bytes', built.length === 64);

// Second real example: the SET that switches to ambient
const real2 = '02 10 01 00 fc 0c 96 c3 41 41 02 02 00 02 14 ff 00 f4';
const built2 = P.buildCommand(P.ADDR_PC_TO_RX, P.EV.NOISE, P.SET, 2, [0x02, 0x14, 0xff, 0x00]);
ok('second real SET matches too', hex(built2.slice(0, 18)) === real2, hex(built2.slice(0, 18)));

console.log('\n2) parseEvent — a frame from the device');
// Build an EVENT frame (same checksum rule: sum(buf[6..N]))
function buildEvent(eventId, eventType, payload, tid = 2, address = 0x14) {
    const n = 12 + payload.length;
    const b = new Uint8Array(64);
    b[0] = 0x02; b[1] = n; b[2] = 0x04; b[3] = 0xff; b[4] = 8 + payload.length;
    b[5] = 0x00; b[6] = 0x96; b[7] = 0xc3; b[8] = address;
    b[9] = eventId; b[10] = eventType; b[11] = tid & 0xff; b[12] = tid >> 8;
    payload.forEach((v, i) => { b[13 + i] = v; });
    let s = 0;
    for (let i = 6; i <= n; i++) s += b[i];
    b[n + 1] = s & 0xff;
    return b;
}

const batFrame = buildEvent(P.EV.BATTERY, P.RET, [...bytes('00 63 00 63 ff 64')]);
const bat = P.parseEvent(batFrame);
ok('frame parsed', bat !== null);
ok('eventId 0x04', bat?.eventId === P.EV.BATTERY);
ok('eventType RET', bat?.eventType === P.RET);
ok('tid 2', bat?.tid === 2);
const b = P.decodeBattery(bat.payload);
ok('battery right=99 left=99 case=100', b.right === 99 && b.left === 99 && b.case === 100,
   JSON.stringify(b));

console.log('\n3) 0x06 bulk status — a payload captured from the device');
const bulkFrame = buildEvent(P.EV.STATUS_BULK, P.RET,
    [...bytes('04 00 63 00 62 ff 64 00 1c ff 32 00 ff')]);
const bulk = P.decodeBulk(P.parseEvent(bulkFrame).payload);
ok('battery right=99 left=98', bulk.battery.right === 99 && bulk.battery.left === 98,
   JSON.stringify(bulk.battery));
ok('volume = 28', bulk.volume === 28, `${bulk.volume}`);
ok('balance = 50', bulk.balance === 50, `${bulk.balance}`);

console.log('\n4) 0x41 noise control');
for (const [payload, mode, label] of [
    ['00 14 ff 00', P.NOISE_OFF, 'off'],
    ['01 14 ff 00', P.NOISE_ANC, 'ANC'],
    ['02 14 ff 00', P.NOISE_AMBIENT, 'ambient'],
]) {
    const n = P.decodeNoise(P.parseEvent(buildEvent(P.EV.NOISE, P.NTFY_ACTIVE, [...bytes(payload)], 1)).payload);
    ok(`${label}: mode=${mode}, ambient=20`, n.mode === mode && n.ambient === 20, JSON.stringify(n));
}
ok('encodeNoise round-trips',
   hex(Uint8Array.from(P.encodeNoise(P.NOISE_AMBIENT, 20))) === '02 14 ff 00');
ok('encodeNoise clamps the ambient maximum',
   P.encodeNoise(P.NOISE_ANC, 99)[1] === P.AMBIENT_MAX);

console.log('\n5) Corrupt frames are rejected');
const bad = Uint8Array.from(batFrame); bad[17] ^= 0xff;   // corrupt the checksum
ok('corrupt checksum rejected', P.parseEvent(bad) === null);
const badKey = Uint8Array.from(batFrame); badKey[6] = 0x00;
ok('wrong sony key rejected', P.parseEvent(badKey) === null);
const notForPc = Uint8Array.from(batFrame); notForPc[8] = 0x41;  // destination RX
ok('frame not addressed to the PC rejected', P.parseEvent(notForPc) === null);
ok('empty buffer rejected', P.parseEvent(new Uint8Array(64)) === null);

console.log('\n6) lowestBud');
ok('lowest earbud', P.lowestBud({left: 93, right: 99, case: 100}) === 93);
ok('case is ignored', P.lowestBud({left: null, right: 80, case: 100}) === 80);
ok('null when neither is known', P.lowestBud({left: null, right: null, case: 100}) === null);

console.log('\n7) 0x24 microphone mute — two states captured from the device');
// Touch-and-hold flips byte[0] 00<->01, byte[1..2] always 0xFF.
// Polarity confirmed against the input level: 0 = live, 1 = muted.
for (const [payload, muted, label] of [
    ['00 ff ff', false, 'live'],
    ['01 ff ff', true, 'muted'],
]) {
    const frame = buildEvent(P.EV.MIC_MUTE, P.NTFY_ACTIVE, [...bytes(payload)], 1);
    ok(`${label}: muted=${muted}`,
       P.decodeMicMuted(P.parseEvent(frame).payload) === muted);
}
ok('encodeMicMuted(true)  -> 01 ff ff',
   hex(Uint8Array.from(P.encodeMicMuted(true))) === '01 ff ff');
ok('encodeMicMuted(false) -> 00 ff ff',
   hex(Uint8Array.from(P.encodeMicMuted(false))) === '00 ff ff');

console.log('\n' + '='.repeat(60));
if (fails) {
    console.log(`FAILED: ${fails} tests`);
    if (typeof process !== 'undefined') process.exit(1);
} else {
    console.log('All tests passed.');
}
