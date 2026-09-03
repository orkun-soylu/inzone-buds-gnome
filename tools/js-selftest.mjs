// protocol.js'in sahada yakalanan GERCEK cercevelere karsi testi.
// Donanim, GNOME veya gjs gerektirmez:  node tools/js-selftest.mjs
// (gjs -m tools/js-selftest.mjs ile de kosar — sadece console.log kullaniyor.)

import * as P from '../src/inzone@soylu.me/protocol.js';

let fails = 0;
const ok = (label, cond, detail = '') => {
    console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${cond || !detail ? '' : `  <- ${detail}`}`);
    if (!cond)
        fails++;
};
const hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');
const bytes = s => Uint8Array.from(s.split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)));

console.log('1) buildCommand — sahada gonderilen GERCEK SET cercevesi');
// 2026-09-02 laptop, query.py'nin bastigi ham byte'lar:
//   SET NOISE_CONTROL(0x41) tid=2 payload=00 14 ff 00
const real = '02 10 01 00 fc 0c 96 c3 41 41 02 02 00 00 14 ff 00 f2';
const built = P.buildCommand(P.ADDR_PC_TO_RX, P.EV.NOISE, P.SET, 2, [0x00, 0x14, 0xff, 0x00]);
ok('byte byte ayni', hex(built.slice(0, 18)) === real, hex(built.slice(0, 18)));
ok('checksum 0xf2', built[17] === 0xf2, `0x${built[17].toString(16)}`);
ok('rapor 64 byte', built.length === 64);

// Ikinci gercek ornek: ambient'e alan SET
const real2 = '02 10 01 00 fc 0c 96 c3 41 41 02 02 00 02 14 ff 00 f4';
const built2 = P.buildCommand(P.ADDR_PC_TO_RX, P.EV.NOISE, P.SET, 2, [0x02, 0x14, 0xff, 0x00]);
ok('ikinci gercek SET de ayni', hex(built2.slice(0, 18)) === real2, hex(built2.slice(0, 18)));

console.log('\n2) parseEvent — cihazdan donen cerceve');
// EVENT cercevesi kur (checksum kurali ayni: sum(buf[6..N]))
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
ok('cerceve cozuldu', bat !== null);
ok('eventId 0x04', bat?.eventId === P.EV.BATTERY);
ok('eventType RET', bat?.eventType === P.RET);
ok('tid 2', bat?.tid === 2);
const b = P.decodeBattery(bat.payload);
ok('batarya sag=99 sol=99 kutu=100', b.right === 99 && b.left === 99 && b.case === 100,
   JSON.stringify(b));

console.log('\n3) 0x06 toplu durum — sahada yakalanan payload');
const bulkFrame = buildEvent(P.EV.STATUS_BULK, P.RET,
    [...bytes('04 00 63 00 62 ff 64 00 1c ff 32 00 ff')]);
const bulk = P.decodeBulk(P.parseEvent(bulkFrame).payload);
ok('batarya sag=99 sol=98', bulk.battery.right === 99 && bulk.battery.left === 98,
   JSON.stringify(bulk.battery));
ok('ses = 28', bulk.volume === 28, `${bulk.volume}`);
ok('balance = 50', bulk.balance === 50, `${bulk.balance}`);

console.log('\n4) 0x41 gurultu kontrolu');
for (const [payload, mode, label] of [
    ['00 14 ff 00', P.NOISE_OFF, 'kapali'],
    ['01 14 ff 00', P.NOISE_ANC, 'ANC'],
    ['02 14 ff 00', P.NOISE_AMBIENT, 'ambient'],
]) {
    const n = P.decodeNoise(P.parseEvent(buildEvent(P.EV.NOISE, P.NTFY_ACTIVE, [...bytes(payload)], 1)).payload);
    ok(`${label}: mode=${mode}, ambient=20`, n.mode === mode && n.ambient === 20, JSON.stringify(n));
}
ok('encodeNoise geri donusumlu',
   hex(Uint8Array.from(P.encodeNoise(P.NOISE_AMBIENT, 20))) === '02 14 ff 00');
ok('encodeNoise ambient tavani kirpiyor',
   P.encodeNoise(P.NOISE_ANC, 99)[1] === P.AMBIENT_MAX);

console.log('\n5) Bozuk cerceveler reddediliyor');
const bad = Uint8Array.from(batFrame); bad[17] ^= 0xff;   // checksum boz
ok('bozuk checksum reddedildi', P.parseEvent(bad) === null);
const badKey = Uint8Array.from(batFrame); badKey[6] = 0x00;
ok('yanlis sony key reddedildi', P.parseEvent(badKey) === null);
const notForPc = Uint8Array.from(batFrame); notForPc[8] = 0x41;  // hedef RX
ok('PC hedefli olmayan reddedildi', P.parseEvent(notForPc) === null);
ok('bos tampon reddedildi', P.parseEvent(new Uint8Array(64)) === null);

console.log('\n6) lowestBud');
ok('en dusuk kulaklik', P.lowestBud({left: 93, right: 99, case: 100}) === 93);
ok('kutu hesaba katilmiyor', P.lowestBud({left: null, right: 80, case: 100}) === 80);
ok('ikisi de yoksa null', P.lowestBud({left: null, right: null, case: 100}) === null);

console.log('\n' + '='.repeat(60));
if (fails) {
    console.log(`BASARISIZ: ${fails} test`);
    if (typeof process !== 'undefined') process.exit(1);
} else {
    console.log('Tum testler gecti.');
}
