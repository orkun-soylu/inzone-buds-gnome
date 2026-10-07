// SPDX-License-Identifier: GPL-2.0-or-later
//
// hidraw discovery + asynchronous I/O.
//
// A read loop matches incoming frames to pending requests by TID; anything
// else is a push from the device (an earbud was touched) and is emitted as
// 'pushed'. Reads use a pollable GioUnix stream, so disable() can cancel them.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import * as Proto from './protocol.js';

const VID = 0x054c;
const PID = 0x0ec2;
const REQUEST_TIMEOUT_MS = 1500;

/** Read a small file asynchronously. */
function readFile(path) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            try {
                resolve(file.load_contents_finish(res)[1]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Find the hidraw node carrying the 0xFF04 vendor collection; resolves null if none. */
export async function findNode() {
    const base = '/sys/class/hidraw';
    const names = [];
    try {
        const dir = GLib.Dir.open(base, 0);
        let name;
        while ((name = dir.read_name()) !== null)
            names.push(name);
        dir.close();
    } catch (e) {
        return null;
    }
    const want = `:${VID.toString(16).padStart(8, '0')}:${PID.toString(16).padStart(8, '0')}`
        .toUpperCase();

    for (const name of names) {
        const devDir = `${base}/${name}/device`;
        let uevent, desc;
        try {
            uevent = new TextDecoder().decode(await readFile(`${devDir}/uevent`));
        } catch (e) {
            continue;
        }

        const line = uevent.split('\n').find(l => l.startsWith('HID_ID='));
        if (!line || !line.slice(7).toUpperCase().endsWith(want))
            continue;

        try {
            desc = await readFile(`${devDir}/report_descriptor`);
        } catch (e) {
            continue;
        }

        // Match by usage page: the usage differs between INZONE models.
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
        // a change the device reported on its own
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
        this._generation = 0;   // bumped by close()
    }

    get isOpen() {
        return this._output !== null;
    }

    get node() {
        return this._node;
    }

    /** Open the device. Resolves false on failure. */
    async open() {
        if (this.isOpen)
            return true;

        const generation = this._generation;
        const node = await findNode();
        // close() ran meanwhile
        if (generation !== this._generation)
            return false;
        if (node === null || this.isOpen)
            return this.isOpen;

        try {
            this._stream = Gio.File.new_for_path(node).open_readwrite(null);
            const fd = this._stream.get_input_stream().get_fd();
            this._input = GioUnix.InputStream.new(fd, false);   // fd stays owned by _stream
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
        this._generation++;
        if (this._cancellable !== null) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        for (const [, p] of this._pending) {
            if (p.timeoutId)
                GLib.source_remove(p.timeoutId);
            p.reject(new Error('device closed'));
        }
        this._pending.clear();

        try {
            this._stream?.close(null);
        } catch (e) {
            // ignore
        }
        this._stream = this._input = this._output = null;
        this._node = null;
    }

    _nextTid() {
        // Skip 0 and 1: the dongle's own pushes carry tid=1.
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

                if (data.length === 0) {    // EOF
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
        this.emit('pushed', info.eventId, info);
    }

    _onDisconnect() {
        this.close();
    }

    /** Send a GET/SET; resolves with the reply, rejects on timeout. */
    request(eventId, eventType, payload = [], address = Proto.ADDR_PC_TO_RX) {
        return new Promise((resolve, reject) => {
            if (!this.isOpen) {
                reject(new Error('device not open'));
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
                    reject(new Error(`0x${eventId.toString(16)} timed out`));
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
