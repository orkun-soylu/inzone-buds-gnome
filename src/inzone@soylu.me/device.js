// hidraw kesfi + asenkron I/O.
//
// GNOME Shell tek thread'lidir: burada HICBIR bloklayan okuma/yazma yok.
// Surekli bir asenkron okuma dongusu var; gelen cerceveler ya bekleyen bir
// istegin TID'iyle eslesir ya da kullanici kulakliga dokundugunda gelen
// kendiliginden push'tur (NTFY_ACTIVE, tid=1) ve 'pushed' sinyali olur.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Proto from './protocol.js';

const VID = 0x054c;
const PID = 0x0ec2;
const REQUEST_TIMEOUT_MS = 1500;

/** 0xFF04 vendor collection tasiyan hidraw node'unu bul; yoksa null. */
export function findNode() {
    const base = '/sys/class/hidraw';
    let dir;
    try {
        dir = GLib.Dir.open(base, 0);
    } catch (e) {
        return null;
    }
    const want = `:${VID.toString(16).padStart(8, '0')}:${PID.toString(16).padStart(8, '0')}`
        .toUpperCase();

    let name;
    while ((name = dir.read_name()) !== null) {
        const devDir = `${base}/${name}/device`;
        let uevent, desc;
        try {
            const [okU, u] = GLib.file_get_contents(`${devDir}/uevent`);
            if (!okU)
                continue;
            uevent = new TextDecoder().decode(u);
            const [okD, d] = GLib.file_get_contents(`${devDir}/report_descriptor`);
            if (!okD)
                continue;
            desc = d;
        } catch (e) {
            continue;
        }

        const line = uevent.split('\n').find(l => l.startsWith('HID_ID='));
        if (!line || !line.slice(7).toUpperCase().endsWith(want))
            continue;

        // Vendor collection'i usage'a gore DEGIL usage_page'e gore ara:
        // H5 0xFF04 icin usage 0x0002 diyor, buds'ta usage 0x0001.
        for (let i = 0; i + 2 < desc.length; i++) {
            if (desc[i] === 0x06 && desc[i + 1] === 0x04 && desc[i + 2] === 0xff)
                return `/dev/${name}`;
        }
    }
    return null;
}

export const InzoneDevice = GObject.registerClass({
    GTypeName: 'InzoneDevice',
    Signals: {
        // cihazdan kendiliginden gelen degisiklik (kulakliga dokunuldu)
        'pushed': {param_types: [GObject.TYPE_UINT, GObject.TYPE_JSOBJECT]},
    },
}, class InzoneDevice extends GObject.Object {
    _init() {
        super._init();
        this._stream = null;
        this._input = null;
        this._output = null;
        this._cancellable = null;
        this._pending = new Map();   // tid -> {resolve, reject, timeoutId}
        this._tid = 1;
        this._node = null;
    }

    get isOpen() {
        return this._output !== null;
    }

    get node() {
        return this._node;
    }

    /** Cihazi ac. Basarisizsa false doner (hata firlatmaz — yoklama yolu bu). */
    open() {
        if (this.isOpen)
            return true;

        const node = findNode();
        if (node === null)
            return false;

        try {
            this._stream = Gio.File.new_for_path(node).open_readwrite(null);
            this._input = this._stream.get_input_stream();
            this._output = this._stream.get_output_stream();
        } catch (e) {
            this._stream = this._input = this._output = null;
            return false;
        }

        this._node = node;
        this._cancellable = new Gio.Cancellable();
        this._readLoop();
        return true;
    }

    close() {
        if (this._cancellable !== null) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        for (const [, p] of this._pending) {
            if (p.timeoutId)
                GLib.source_remove(p.timeoutId);
            p.reject(new Error('cihaz kapatildi'));
        }
        this._pending.clear();

        try {
            this._stream?.close(null);
        } catch (e) {
            // kapanis hatasi onemsiz
        }
        this._stream = this._input = this._output = null;
        this._node = null;
    }

    _nextTid() {
        // 0 ve 1 kullanilmaz: dongle'in kendi push'lari tid=1 tasir, yeniden
        // kullanilirsa bir push bizim cevabimiz sanilir.
        this._tid += 1;
        if (this._tid > 0xfff0 || this._tid < 2)
            this._tid = 2;
        return this._tid;
    }

    _readLoop() {
        if (this._input === null || this._cancellable === null)
            return;

        this._input.read_bytes_async(
            Proto.REPORT_SIZE, GLib.PRIORITY_DEFAULT, this._cancellable,
            (src, res) => {
                let data;
                try {
                    data = src.read_bytes_finish(res).get_data();
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._onDisconnect();
                    return;
                }

                const info = Proto.parseEvent(data);
                if (info !== null)
                    this._dispatch(info);

                this._readLoop();
            });
    }

    _dispatch(info) {
        const waiter = this._pending.get(info.tid);
        if (waiter !== undefined && info.eventType !== Proto.NTFY_ACTIVE) {
            this._pending.delete(info.tid);
            if (waiter.timeoutId)
                GLib.source_remove(waiter.timeoutId);
            waiter.resolve(info);
            return;
        }
        // Bekleyen yok -> cihazin kendiliginden bildirimi.
        this.emit('pushed', info.eventId, info);
    }

    _onDisconnect() {
        this.close();
    }

    /** GET/SET yolla, cevabi bekle. Promise<info>. Zaman asiminda reject. */
    request(eventId, eventType, payload = [], address = Proto.ADDR_PC_TO_RX) {
        return new Promise((resolve, reject) => {
            if (!this.isOpen) {
                reject(new Error('cihaz kapali'));
                return;
            }
            const tid = this._nextTid();
            const cmd = Proto.buildCommand(address, eventId, eventType, tid, payload);

            try {
                this._output.write_bytes(new GLib.Bytes(cmd), this._cancellable);
            } catch (e) {
                this._onDisconnect();
                reject(e);
                return;
            }

            const timeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
                    this._pending.delete(tid);
                    reject(new Error(`0x${eventId.toString(16)} zaman asimi`));
                    return GLib.SOURCE_REMOVE;
                });

            this._pending.set(tid, {resolve, reject, timeoutId});
        });
    }

    get(eventId) {
        return this.request(eventId, Proto.GET);
    }

    set(eventId, payload) {
        return this.request(eventId, Proto.SET, payload);
    }
});
