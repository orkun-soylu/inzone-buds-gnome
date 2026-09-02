#!/usr/bin/env -S gjs -m
//
// GJS'ten /dev/hidraw erisimi calisiyor mu?  Extension'in ON KOSULU.
//
// Python tarafi protokolu zaten dogruladi. Burada sorulan tek sey: GNOME Shell'in
// calistigi dilden (GJS/Gio) ayni cihaza yazip okuyabiliyor muyuz. Cevap evetse
// extension saf GJS olabilir, ayri backend binary'sine gerek kalmaz.
//
// Calistir:  sudo gjs -m tools/gjs-probe.js
//
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';   // ESM modunda legacy `imports` yok

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
const NOISE_MODES = {0: 'ANC', 1: 'kapali?', 2: 'ambient'};

function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

/** 054c:0ec2'ye ait, 0xFF04 vendor collection tasiyan hidraw node'unu bul. */
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

/** Sony vendor HCI COMMAND kur. checksum = sum(buf[6..N]) & 0xFF, konum buf[N+1]. */
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

/** EVENT cercevesini coz; Sony cercevesi degilse null. */
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
        const one = (st, pct) => pct === 0xff ? 'yok'
            : `${pct}%${st === 0xff ? ' (durum bilinmiyor)' : st ? ' (sarj)' : ''}`;
        return `batarya: sag=${one(p[0], p[1])}, sol=${one(p[2], p[3])}, kutu=${one(p[4], p[5])}`;
    }
    if (eventId === 0x41 && p.length >= 2)
        return `gurultu kontrolu: ${NOISE_MODES[p[0]] ?? `bilinmeyen-${p[0]}`}, ambient=${p[1]}/20`;
    if (eventId === 0x21 && p.length >= 2)
        return `ses seviyesi = ${p[1]}`;
    return null;
}

// ---------------------------------------------------------------- ana akis

const node = findNode();
if (node === null) {
    printerr('HATA: 0xFF04 vendor collection tasiyan hidraw node bulunamadi.');
    printerr('Dongle takili mi? sudo ile mi calistirdin?');
    System.exit(1);
}
print(`Node: ${node}`);

// Iki acma yolu var; hangisinin karakter aygitinda calistigini olcuyoruz.
//  A) open_readwrite -> tek GFileIOStream (O_RDWR)
//  B) read() + append_to() -> ayri giris/cikis akislari (O_RDONLY / O_WRONLY|O_APPEND)
// A tercih edilir; hidraw'da calismazsa B'ye dusuyoruz. Ikisi de olmazsa saf GJS
// yolu kapali demektir ve extension ayri bir backend binary'si gerektirir.
const file = Gio.File.new_for_path(node);
let stream = null, input = null, output = null, howOpened = null;

try {
    stream = file.open_readwrite(null);
    input = stream.get_input_stream();
    output = stream.get_output_stream();
    howOpened = 'open_readwrite (O_RDWR)';
} catch (e) {
    print(`open_readwrite basarisiz: ${e.message}`);
    print('yedek yola geciliyor: read() + append_to()');
    try {
        input = file.read(null);
        output = file.append_to(Gio.FileCreateFlags.NONE, null);
        howOpened = 'read + append_to (ayri akislar)';
    } catch (e2) {
        printerr(`HATA: ${node} hicbir yoldan acilamadi: ${e2.message}`);
        printerr("Izin sorunuysa 'sudo' ile calistir.");
        printerr('Degilse GJS hidraw\'a dogrudan erisemiyor -> extension backend binary gerektirir.');
        System.exit(1);
    }
}
print(`Acilis yontemi: ${howOpened}`);

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
        printerr(`   yazma hatasi: ${e.message}`);
        next();
        return;
    }

    let done = false;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        if (!done) {
            done = true;
            print('   (cevap yok — zaman asimi)');
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
            printerr(`   okuma hatasi: ${e.message}`);
            next();
            return;
        }
        const info = parseEvent(data);
        if (info === null) {
            print(`   sony cercevesi degil: ${hex(data.slice(0, 20))}`);
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
    // kapanis hatasi sonucu degistirmez
}

print('\n' + '='.repeat(60));
if (okCount === 3) {
    print(`SONUC: GJS hidraw uzerinden okuyup yaziyor (${howOpened}).`);
    print('        Saf GJS extension MUMKUN, ayri backend binary gerekmiyor.');
} else {
    print(`SONUC: ${okCount}/3 sorgu basarili. Ayrintiya bak;`);
    print('       hicbiri gelmiyorsa extension ayri bir backend binary gerektirir.');
}
