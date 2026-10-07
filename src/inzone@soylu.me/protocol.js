// SPDX-License-Identifier: GPL-2.0-or-later
//
// Sony INZONE vendor HCI-over-HID protocol.
//
// No GNOME imports, so tools/js-selftest.mjs runs it in node. See
// docs/protocol.md for how each value was measured.
//
// Frame:
//   [0]      report id = 0x02
//   [1]      hid_length = 12 + payload
//   [2]      0x01 COMMAND (host->device) | 0x04 EVENT (device->host)
//   [3..4]   COMMAND: opcode 0xFC00 (LE)  |  EVENT: [3]=0xFF event code, [4]=param_length
//   [5]      COMMAND: param_length        |  EVENT: dummy 0x00
//   [6..7]   sony key 0xC396 (LE: 96 c3)
//   [8]      address = (dst<<4)|src   1=PC 2=TX(dongle) 4=RX(earbuds)
//   [9]      event_id
//   [10]     event_type
//   [11..12] transaction id (LE)
//   [13..N]  payload
//   [N+1]    checksum = sum(buf[6..N]) & 0xFF, in both directions

export const REPORT_SIZE = 64;
export const REPORT_ID = 0x02;
const KEY_LO = 0x96, KEY_HI = 0xc3;

export const ADDR_PC_TO_RX = 0x41;   // earbuds
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

// 0x41 byte[0]
export const NOISE_OFF = 0;
export const NOISE_ANC = 1;
export const NOISE_AMBIENT = 2;

export const AMBIENT_MAX = 20;   // Sony's range is 0-20

// 0x24 byte[0]: a mute switch, not a level
export const MIC_ON = 0;
export const MIC_MUTED = 1;
export const BALANCE_MAX = 100;  // 0 = all chat (game muted), 100 = all game

// The device silently rejects balance values that are not multiples of 10.
export const BALANCE_STEP = 10;
export const VOLUME_MAX = 50;

/** Build a COMMAND frame. payload: array of numbers. */
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

/** Parse an EVENT frame. null if it is not a Sony frame. */
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
    if ((buf[8] >> 4) !== 0x1)      // destination must be the PC
        return null;

    let sum = 0;
    for (let i = 6; i <= n; i++)
        sum += buf[i];
    if ((sum & 0xff) !== buf[n + 1])
        return null;                // corrupt frame — drop it silently

    return {
        eventId: buf[9],
        eventType: buf[10],
        tid: buf[11] | (buf[12] << 8),
        payload: buf.slice(13, n + 1),
    };
}

/** 0x04 payload -> {right, left, case} in percent; null where unknown. */
export function decodeBattery(p) {
    if (p.length < 6)
        return null;
    const one = pct => (pct === 0xff ? null : pct);
    return {right: one(p[1]), left: one(p[3]), case: one(p[5])};
}

/** 0x06 bulk status -> battery + volume + balance. */
export function decodeBulk(p) {
    if (p.length < 11)
        return null;
    return {
        battery: decodeBattery(p.slice(1, 7)),
        volume: p[8],
        balance: p[10],
    };
}

/** 0x24 -> true = microphone muted. */
export function decodeMicMuted(p) {
    if (!p.length)
        return null;
    return p[0] === MIC_MUTED;
}

/** 0x24 SET payload. byte[1..2] = 0xFF, as in the device's own frame. */
export function encodeMicMuted(muted) {
    return [muted ? MIC_MUTED : MIC_ON, 0xff, 0xff];
}

/** 0x41 -> {mode, ambient}. */
export function decodeNoise(p) {
    if (p.length < 2)
        return null;
    return {mode: p[0], ambient: p[1]};
}

/** 0x41 SET payload. byte[2]=0xFF placeholder, byte[3]=0x00 (measured). */
export function encodeNoise(mode, ambient) {
    return [mode & 0xff, Math.max(0, Math.min(AMBIENT_MAX, ambient)), 0xff, 0x00];
}

/** Lowest remaining earbud percentage — for the indicator. null if neither is known. */
export function lowestBud(battery) {
    if (battery === null)
        return null;
    const vals = [battery.left, battery.right].filter(v => v !== null);
    return vals.length ? Math.min(...vals) : null;
}
