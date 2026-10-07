#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Does /dev/hidraw access work from GJS?  The extension's PREREQUISITE.
//
// The Python tools had already confirmed the protocol. The only question here:
// can the language GNOME Shell runs in (GJS/Gio) write to and read from the same
// device? If so, the extension can be pure GJS with no separate backend binary.
//
// Run:  sudo gjs -m tools/gjs-probe.js
//
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';   // no legacy `imports` in ESM mode

const VID = 0x054c;
const PID = 0x0ec2;
const REPORT_SIZE = 64;
const REPORT_ID = 0x02;
const KEY_LO = 0x96, KEY_HI = 0xc3;
const ADDR_PC_TO_RX = 0x41;
const ETYPE_GET = 0x01;

const EVENT_NAMES = {
    0x04: 'BATTERY_INFO',
    0x21: 'HEADPHONE_VOLUME',
    0x22: 'GAME_CHAT_MIX_BALANCE',
    0x41: 'NOISE_CONTROL',
};
const NOISE_MODES = {0: 'off', 1: 'ANC', 2: 'ambient'};  // verified on the device

function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

/** Find the 054c:0ec2 hidraw node carrying the 0xFF04 vendor collection. */
function findNode() {
    const base = '/sys/class/hidraw';
    let dir;
    try {
        dir = GLib.Dir.open(base, 0);
    } catch (e) {
        return null;
    }
    const want = `:${VID.toString(16).padStart(8, '0')}:${PID.toString(16).padStart(8, '0')}`.toUpperCase();
    let name;
    while ((name = dir.read_name()) !== null) {
        const devDir = `${base}/${name}/device`;
        const [okU, uevent] = GLib.file_get_contents(`${devDir}/uevent`);
        if (!okU)
            continue;
        const text = new TextDecoder().decode(uevent);
        const line = text.split('\n').find(l => l.startsWith('HID_ID='));
        if (!line || !line.slice(7).toUpperCase().endsWith(want))
            continue;

        const [okD, desc] = GLib.file_get_contents(`${devDir}/report_descriptor`);
        if (!okD)
            continue;
        // Usage Page (16-bit) 0xFF04 -> 06 04 ff
        let vendor = false;
        for (let i = 0; i + 2 < desc.length; i++) {
            if (desc[i] === 0x06 && desc[i + 1] === 0x04 && desc[i + 2] === 0xff) {
                vendor = true;
                break;
            }
        }
        if (vendor)
            return `/dev/${name}`;
    }
    return null;
}

/** Build a Sony vendor HCI COMMAND. checksum = sum(buf[6..N]) & 0xFF, at buf[N+1]. */
function buildCommand(address, eventId, eventType, tid, payload = []) {
    const n = payload.length;
    const buf = new Uint8Array(REPORT_SIZE);
    buf[0] = REPORT_ID;
    buf[1] = 12 + n;          // hid_length
    buf[2] = 0x01;            // HCI COMMAND
    buf[3] = 0x00;            // opcode 0xFC00 (LE)
    buf[4] = 0xfc;
    buf[5] = 8 + n;           // param_length
    buf[6] = KEY_LO;
    buf[7] = KEY_HI;
    buf[8] = address;
    buf[9] = eventId;
    buf[10] = eventType;
    buf[11] = tid & 0xff;
    buf[12] = (tid >> 8) & 0xff;
    for (let i = 0; i < n; i++)
        buf[13 + i] = payload[i];

    let sum = 0;
    for (let i = 6; i < 13 + n; i++)
        sum += buf[i];
    buf[13 + n] = sum & 0xff;
    return buf;
}

/** Parse an EVENT frame; null if it is not a Sony frame. */
function parseEvent(buf) {
    if (buf[0] !== REPORT_ID)
        return null;
    const n = buf[1];
    if (n < 12 || n > REPORT_SIZE - 2)
        return null;
    if (buf[2] !== 0x04 || buf[3] !== 0xff)   // HCI EVENT + sony event code
        return null;
    if (buf[6] !== KEY_LO || buf[7] !== KEY_HI)
        return null;

    let sum = 0;
    for (let i = 6; i <= n; i++)
        sum += buf[i];
    return {
        eventId: buf[9],
        eventType: buf[10],
        tid: buf[11] | (buf[12] << 8),
        payload: buf.slice(13, n + 1),
        checksumOk: (sum & 0xff) === buf[n + 1],
    };
}

function describe(eventId, p) {
    if (eventId === 0x04 && p.length === 6) {
        const one = (st, pct) => pct === 0xff ? 'absent'
            : `${pct}%${st === 0xff ? ' (status unknown)' : st ? ' (charging)' : ''}`;
        return `battery: right=${one(p[0], p[1])}, left=${one(p[2], p[3])}, case=${one(p[4], p[5])}`;
    }
    if (eventId === 0x41 && p.length >= 2)
        return `noise control: ${NOISE_MODES[p[0]] ?? `unknown-${p[0]}`}, ambient=${p[1]}/20`;
    if (eventId === 0x21 && p.length >= 2)
        return `volume = ${p[1]}`;
    return null;
}

// ---------------------------------------------------------------- main flow

const node = findNode();
if (node === null) {
    printerr('ERROR: no hidraw node carrying the 0xFF04 vendor collection was found.');
    printerr('Is the dongle plugged in? Did you run this with sudo?');
    System.exit(1);
}
print(`Node: ${node}`);

// There are two ways to open it; we measure which one works on a character device.
//  A) open_readwrite -> a single GFileIOStream (O_RDWR)
//  B) read() + append_to() -> separate input/output streams (O_RDONLY / O_WRONLY|O_APPEND)
// A is preferred; if it fails on hidraw we fall back to B. If neither works the
// pure-GJS route is closed and the extension would need a separate backend binary.
const file = Gio.File.new_for_path(node);
let stream = null, input = null, output = null, howOpened = null;

try {
    stream = file.open_readwrite(null);
    input = stream.get_input_stream();
    output = stream.get_output_stream();
    howOpened = 'open_readwrite (O_RDWR)';
} catch (e) {
    print(`open_readwrite failed: ${e.message}`);
    print('falling back to read() + append_to()');
    try {
        input = file.read(null);
        output = file.append_to(Gio.FileCreateFlags.NONE, null);
        howOpened = 'read + append_to (separate streams)';
    } catch (e2) {
        printerr(`ERROR: ${node} could not be opened either way: ${e2.message}`);
        printerr("If it is a permission problem, run with 'sudo'.");
        printerr('Otherwise GJS cannot reach hidraw directly -> the extension needs a backend binary.');
        System.exit(1);
    }
}
print(`Opened with: ${howOpened}`);

const loop = new GLib.MainLoop(null, false);
const queue = [0x04, 0x41, 0x21];
let tid = 10;
let okCount = 0;

function next() {
    const eventId = queue.shift();
    if (eventId === undefined) {
        loop.quit();
        return;
    }
    const name = EVENT_NAMES[eventId] ?? 'UNKNOWN';
    tid += 1;
    const cmd = buildCommand(ADDR_PC_TO_RX, eventId, ETYPE_GET, tid);

    print(`\n-> GET ${name}(0x${eventId.toString(16)}) tid=${tid}`);
    try {
        output.write_bytes(new GLib.Bytes(cmd), null);
    } catch (e) {
        printerr(`   write error: ${e.message}`);
        next();
        return;
    }

    let done = false;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        if (!done) {
            done = true;
            print('   (no reply — timed out)');
            next();
        }
        return GLib.SOURCE_REMOVE;
    });

    input.read_bytes_async(REPORT_SIZE, GLib.PRIORITY_DEFAULT, null, (src, res) => {
        if (done)
            return;
        done = true;
        GLib.source_remove(timer);
        let data;
        try {
            data = src.read_bytes_finish(res).get_data();
        } catch (e) {
            printerr(`   read error: ${e.message}`);
            next();
            return;
        }
        const info = parseEvent(data);
        if (info === null) {
            print(`   not a sony frame: ${hex(data.slice(0, 20))}`);
        } else {
            print(`   <- 0x${info.eventId.toString(16)} tid=${info.tid} ` +
                  `payload=${hex(info.payload)}${info.checksumOk ? '' : '  !! checksum'}`);
            const note = describe(info.eventId, info.payload);
            if (note)
                print(`      -> ${note}`);
            if (info.checksumOk && info.eventId === eventId)
                okCount += 1;
        }
        next();
    });
}

next();
loop.run();
try {
    if (stream !== null)
        stream.close(null);
    else {
        input.close(null);
        output.close(null);
    }
} catch (e) {
    // a failed close does not change the result
}

print('\n' + '='.repeat(60));
if (okCount === 3) {
    print(`RESULT: GJS reads and writes over hidraw (${howOpened}).`);
    print('        A pure-GJS extension IS possible, no separate backend binary needed.');
} else {
    print(`RESULT: ${okCount}/3 queries succeeded. See the details above;`);
    print('        if none came back the extension needs a separate backend binary.');
}
