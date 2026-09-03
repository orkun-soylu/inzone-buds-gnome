// Sony INZONE vendor HCI-over-HID protokolu.
//
// Saf fonksiyonlar — Gio/Shell bagimliligi YOK, boylece `gjs` ile tek basina
// test edilebilir (bkz. tools/gjs-selftest.js).
//
// Cerceve:
//   [0]      report id = 0x02
//   [1]      hid_length = 12 + payload
//   [2]      0x01 COMMAND (host->cihaz) | 0x04 EVENT (cihaz->host)
//   [3..4]   COMMAND: opcode 0xFC00 (LE)  |  EVENT: [3]=0xFF event code, [4]=param_length
//   [5]      COMMAND: param_length        |  EVENT: dummy 0x00
//   [6..7]   sony key 0xC396 (LE: 96 c3)
//   [8]      address = (dst<<4)|src   1=PC 2=TX(dongle) 4=RX(kulaklik)
//   [9]      event_id
//   [10]     event_type
//   [11..12] transaction id (LE)
//   [13..N]  payload
//   [N+1]    checksum = sum(buf[6..N]) & 0xFF
//
// Checksum kurali her iki yonde de buf[6]'dan baslar. H5 surucusunun okuma
// tarafindaki buf[5..N] formulu yalnizca EVENT'lerde buf[5] sifir dummy oldugu
// icin ayni sonucu verir; COMMAND'da buf[5]=param_length ve yanlis cikar.

export const REPORT_SIZE = 64;
export const REPORT_ID = 0x02;
const KEY_LO = 0x96, KEY_HI = 0xc3;

export const ADDR_PC_TO_RX = 0x41;   // kulaklik
export const ADDR_PC_TO_TX = 0x21;   // dongle

export const GET = 0x01;
export const SET = 0x02;
export const RET = 0x10;
export const NTFY = 0x20;
export const NTFY_ACTIVE = 0xa0;

export const EV = {
    CONNECT: 0x01,
    BATTERY: 0x04,
    STATUS_BULK: 0x06,
    VOLUME: 0x21,
    BALANCE: 0x22,
    SIDETONE: 0x23,
    MIC_MUTE: 0x24,
    NOISE: 0x41,
};

// 0x41 byte[0]. Esleme kullanici tarafindan cihaz uzerinde DOGRULANDI
// (2026-09-03). Onceki 0=ANC / 1=kapali okumasi YANLISTI; dinleme testinde
// kapali moddaki pasif yalitim ANC sanilmisti.
export const NOISE_OFF = 0;
export const NOISE_ANC = 1;
export const NOISE_AMBIENT = 2;

export const AMBIENT_MAX = 20;   // Sony araligi 0-20

// 0x24 SEVIYE DEGIL, mute anahtari (olculdu 2026-09-03). Sol kulaklikta
// dokun-ve-tut ile byte[0] 00<->01 arasinda gidip geldi, byte[1..2] boyunca
// 0xFF sabit kaldi -- yani orada seviye yok. Polarite ses giris seviyesine
// bakilarak dogrulandi. "MIC_VOLUME" adi H5'ten miras yanlis etiketti.
export const MIC_ON = 0;
export const MIC_MUTED = 1;
// 0x22 tavani ve yonu OLCULDU (2026-09-03, laptop). Onceki 90 H5'ten tasinmis
// dayanaksiz bir varsayimdi: cihaz SET 0x64'u kabul etti ve geri okudu, kirpmadi.
// Yon de tersti — 0 oyun akisini SUSTURUYOR, 100 tam guclu veriyor.
export const BALANCE_MAX = 100;  // 0 = tam sohbet (oyun kisik), 100 = tam oyun

// 10'un kati OLMAYAN degerler cihaz tarafindan sessizce REDDEDILIYOR (olculdu
// 2026-09-03): SET 0x37 (55) icin NTFY eski degeri geri dondu, ayni oturumda
// SET 0x32 (50) kabul edildi. Yani asagidaki yuvarlama ihtiyat degil zorunluluk
// -- olmasa slider konumlarinin cogu sessizce hicbir sey yapmazdi.
export const BALANCE_STEP = 10;
export const VOLUME_MAX = 50;

/** COMMAND cercevesi kur. payload: sayi dizisi. */
export function buildCommand(address, eventId, eventType, tid, payload = []) {
    const n = payload.length;
    const buf = new Uint8Array(REPORT_SIZE);
    buf[0] = REPORT_ID;
    buf[1] = 12 + n;
    buf[2] = 0x01;
    buf[3] = 0x00;
    buf[4] = 0xfc;
    buf[5] = 8 + n;
    buf[6] = KEY_LO;
    buf[7] = KEY_HI;
    buf[8] = address;
    buf[9] = eventId;
    buf[10] = eventType;
    buf[11] = tid & 0xff;
    buf[12] = (tid >> 8) & 0xff;
    for (let i = 0; i < n; i++)
        buf[13 + i] = payload[i] & 0xff;

    let sum = 0;
    for (let i = 6; i < 13 + n; i++)
        sum += buf[i];
    buf[13 + n] = sum & 0xff;
    return buf;
}

/** EVENT cercevesini coz. Sony cercevesi degilse null. */
export function parseEvent(buf) {
    if (buf.length < 14 || buf[0] !== REPORT_ID)
        return null;
    const n = buf[1];
    if (n < 12 || n > REPORT_SIZE - 2)
        return null;
    if (buf[2] !== 0x04 || buf[3] !== 0xff)
        return null;
    if (buf[6] !== KEY_LO || buf[7] !== KEY_HI)
        return null;
    if ((buf[8] >> 4) !== 0x1)      // hedef PC olmali
        return null;

    let sum = 0;
    for (let i = 6; i <= n; i++)
        sum += buf[i];
    if ((sum & 0xff) !== buf[n + 1])
        return null;                // bozuk cerceve — sessizce at

    return {
        eventId: buf[9],
        eventType: buf[10],
        tid: buf[11] | (buf[12] << 8),
        payload: buf.slice(13, n + 1),
    };
}

/** 0x04 payload'i -> {right, left, case} yuzde; bilinmiyorsa null. */
export function decodeBattery(p) {
    if (p.length < 6)
        return null;
    const one = pct => (pct === 0xff ? null : pct);
    return {right: one(p[1]), left: one(p[3]), case: one(p[5])};
}

/** 0x06 toplu durum -> batarya + ses + balance. */
export function decodeBulk(p) {
    if (p.length < 11)
        return null;
    return {
        battery: decodeBattery(p.slice(1, 7)),
        volume: p[8],
        balance: p[10],
    };
}

/** 0x24 -> true = mikrofon kapali. */
export function decodeMicMuted(p) {
    if (!p.length)
        return null;
    return p[0] === MIC_MUTED;
}

/** 0x24 SET payload'i. byte[1..2] = 0xFF, cihazin kendi cercevesindeki gibi. */
export function encodeMicMuted(muted) {
    return [muted ? MIC_MUTED : MIC_ON, 0xff, 0xff];
}

/** 0x41 -> {mode, ambient}. */
export function decodeNoise(p) {
    if (p.length < 2)
        return null;
    return {mode: p[0], ambient: p[1]};
}

/** 0x41 SET payload'i. byte[2]=0xFF placeholder, byte[3]=0x00 (olculdu). */
export function encodeNoise(mode, ambient) {
    return [mode & 0xff, Math.max(0, Math.min(AMBIENT_MAX, ambient)), 0xff, 0x00];
}

/** Kalan en dusuk kulaklik yuzdesi — gosterge icin. Ikisi de yoksa null. */
export function lowestBud(battery) {
    if (battery === null)
        return null;
    const vals = [battery.left, battery.right].filter(v => v !== null);
    return vals.length ? Math.min(...vals) : null;
}
