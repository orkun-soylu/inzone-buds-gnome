// SPDX-License-Identifier: GPL-2.0-or-later
//
// INZONE Buds — GNOME Quick Settings control.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Proto from './protocol.js';
import {InzoneDevice} from './device.js';

const POLL_OPEN_MS = 2000;    // while Quick Settings is open
const POLL_CLOSED_MS = 10000; // while it is closed
const DRAG_DEBOUNCE_MS = 220; // slider drags
const USER_HOLD_MS = 2000;    // keeps a poll from overwriting the UI right after a drag

/** A menu row holding a slider — takes no space in the Quick Settings grid. */
const SliderRow = GObject.registerClass(
class SliderRow extends PopupMenu.PopupBaseMenuItem {
    _init(iconName, onChange) {
        super._init({activate: false});
        this.setOrnament(PopupMenu.Ornament.HIDDEN);

        this.add_child(new St.Icon({styleClass: 'popup-menu-icon', iconName}));
        this.slider = new Slider(0);
        this.slider.x_expand = true;
        this.add_child(this.slider);

        this._pendingId = 0;
        this._suppress = false;
        this._onChange = onChange;
        this.slider.connect('notify::value', () => {
            if (this._suppress)
                return;
            if (this._pendingId)
                GLib.source_remove(this._pendingId);
            this._pendingId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, DRAG_DEBOUNCE_MS, () => {
                    this._pendingId = 0;
                    this._onChange(this.slider.value);
                    return GLib.SOURCE_REMOVE;
                });
        });
    }

    /** Show a value read from the device — without firing our own 'notify' handler. */
    setValueQuiet(value) {
        this._suppress = true;
        this.slider.value = value;
        this._suppress = false;
    }

    destroy() {
        if (this._pendingId) {
            GLib.source_remove(this._pendingId);
            this._pendingId = 0;
        }
        super.destroy();
    }
});

/**
 * Noise-mode row. Does NOT use the shell's Ornament: Ornament.NONE hides the
 * check icon and it stops taking up space, so the selected row's label was
 * shifted right relative to the others. We add our own icon and change its
 * OPACITY rather than its visibility — the space stays reserved and all three
 * rows start at the same offset.
 */
const ModeRow = GObject.registerClass(
class ModeRow extends PopupMenu.PopupBaseMenuItem {
    _init(text) {
        super._init();
        this.setOrnament(PopupMenu.Ornament.HIDDEN);

        this._check = new St.Icon({
            styleClass: 'popup-menu-icon',
            iconName: 'object-select-symbolic',
            opacity: 0,
        });
        this.add_child(this._check);

        const label = new St.Label({text, xExpand: true});
        this.add_child(label);
        this.label_actor = label;
    }

    setSelected(selected) {
        this._check.opacity = selected ? 255 : 0;
    }
});

const InzoneToggle = GObject.registerClass(
class InzoneToggle extends QuickMenuToggle {
    _init(device) {
        super._init({
            title: _('INZONE Buds'),
            iconName: 'audio-headphones-symbolic',
            toggleMode: true,
        });
        this._device = device;
        this._lastUserAction = 0;
        this._mode = Proto.NOISE_OFF;
        this._ambient = Proto.AMBIENT_MAX;
        this._micMuted = false;

        this.menu.setHeader('audio-headphones-symbolic', _('INZONE Buds'));

        // --- noise control, three states
        this._modeItems = new Map();
        for (const [mode, label] of [
            [Proto.NOISE_ANC, _('Noise cancelling')],
            [Proto.NOISE_OFF, _('Off')],
            [Proto.NOISE_AMBIENT, _('Ambient sound')],
        ]) {
            const item = new ModeRow(label);
            item.connect('activate', () => this._applyMode(mode));
            this.menu.addMenuItem(item);
            this._modeItems.set(mode, item);
        }

        // --- ambient sound level (0-20)
        // It used to have no heading and a microphone icon, and was taken for
        // the mic level. An icon alone does not tell the two sliders apart.
        this.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem(_('Ambient sound level')));
        this._ambientRow = new SliderRow('audio-volume-high-symbolic', value => {
            this._lastUserAction = GLib.get_monotonic_time();
            const level = Math.round(value * Proto.AMBIENT_MAX);
            this._ambient = level;
            this._device.set(Proto.EV.NOISE, Proto.encodeNoise(this._mode, level))
                .catch(() => {});
        });
        this.menu.addMenuItem(this._ambientRow);

        // --- game / chat balance (0-100)
        this.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem(_('Game / chat balance')));
        this._balanceRow = new SliderRow('applications-games-symbolic', value => {
            this._lastUserAction = GLib.get_monotonic_time();
            // The device ENFORCES steps of 10 — values in between are silently rejected.
            const step = Math.round(value * Proto.BALANCE_MAX / Proto.BALANCE_STEP)
                * Proto.BALANCE_STEP;
            this._device.set(Proto.EV.BALANCE, [step]).catch(() => {});
        });
        this.menu.addMenuItem(this._balanceRow);

        // --- microphone: 0x24 is NOT a level but a mute switch (measured),
        // hence a switch rather than a slider. Switch ON = microphone live.
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._micItem = new PopupMenu.PopupSwitchMenuItem(_('Microphone'), true);
        this._micItem.connect('toggled', (_item, state) => {
            this._lastUserAction = GLib.get_monotonic_time();
            this._micMuted = !state;
            this._device.set(Proto.EV.MIC_MUTE, Proto.encodeMicMuted(this._micMuted))
                .catch(() => {});
        });
        this.menu.addMenuItem(this._micItem);

        this.connect('clicked', () => {
            // Toggle = ANC on/off. Ambient sound is picked from the menu.
            this._applyMode(this.checked ? Proto.NOISE_ANC : Proto.NOISE_OFF);
        });
    }

    /** Did the user just touch a control — a poll must not overwrite it. */
    get _userIsHolding() {
        return GLib.get_monotonic_time() - this._lastUserAction < USER_HOLD_MS * 1000;
    }

    _applyMode(mode) {
        this._lastUserAction = GLib.get_monotonic_time();
        this._mode = mode;
        this._renderNoise();
        this._device.set(Proto.EV.NOISE, Proto.encodeNoise(mode, this._ambient))
            .catch(() => {});
    }

    _renderNoise() {
        for (const [mode, item] of this._modeItems)
            item.setSelected(mode === this._mode);
        this.checked = this._mode === Proto.NOISE_ANC;
        this._ambientRow.sensitive = this._mode === Proto.NOISE_AMBIENT;
        this._ambientRow.setValueQuiet(this._ambient / Proto.AMBIENT_MAX);
    }

    updateNoise(noise) {
        if (noise === null || this._userIsHolding)
            return;
        this._mode = noise.mode;
        this._ambient = noise.ambient;
        this._renderNoise();
    }

    /** setToggleState does not emit 'toggled' — no feedback loop. */
    updateMic(muted) {
        if (muted === null || this._userIsHolding)
            return;
        this._micMuted = muted;
        this._micItem.setToggleState(!muted);
    }

    updateBulk(bulk) {
        if (bulk === null)
            return;
        if (!this._userIsHolding)
            this._balanceRow.setValueQuiet(bulk.balance / Proto.BALANCE_MAX);

        const low = Proto.lowestBud(bulk.battery);
        const b = bulk.battery;
        this.subtitle = low === null
            ? null
            : (b.left === b.right
                ? `${low}%`
                : `L ${b.left ?? '–'}% · R ${b.right ?? '–'}%`);
        // Don't rely on String.prototype.format — the shell installs it in its
        // own environment, but it is not a contract an extension should lean on.
        this.menu.setHeader('audio-headphones-symbolic', _('INZONE Buds'),
            low === null ? null : `${_('Battery')} ${low}%`);
    }
});

const InzoneIndicator = GObject.registerClass(
class InzoneIndicator extends SystemIndicator {
    _init(device) {
        super._init();
        this.toggle = new InzoneToggle(device);
        this.quickSettingsItems.push(this.toggle);
    }
});

export default class InzoneExtension extends Extension {
    enable() {
        this._device = new InzoneDevice();
        this._indicator = new InzoneIndicator(this._device);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // The device reports earbud touches on its own — keep the UI live.
        this._pushId = this._device.connect('pushed', (_dev, eventId, info) => {
            if (eventId === Proto.EV.NOISE)
                this._indicator.toggle.updateNoise(Proto.decodeNoise(info.payload));
            else if (eventId === Proto.EV.MIC_MUTE)
                this._indicator.toggle.updateMic(Proto.decodeMicMuted(info.payload));
            else if (eventId === Proto.EV.BATTERY || eventId === Proto.EV.BALANCE)
                this._refresh();
        });

        const qsMenu = Main.panel.statusArea.quickSettings.menu;
        this._menuId = qsMenu.connect('open-state-changed', (_m, open) => {
            this._restartPoll(open ? POLL_OPEN_MS : POLL_CLOSED_MS);
        });

        this._restartPoll(POLL_CLOSED_MS);
        this._refresh();
    }

    disable() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._menuId) {
            Main.panel.statusArea.quickSettings.menu.disconnect(this._menuId);
            this._menuId = 0;
        }
        if (this._pushId) {
            this._device.disconnect(this._pushId);
            this._pushId = 0;
        }
        this._indicator?.quickSettingsItems.forEach(i => i.destroy());
        this._indicator?.destroy();
        this._indicator = null;
        this._device?.close();
        this._device = null;
    }

    _restartPoll(intervalMs) {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        const toggle = this._indicator?.toggle;
        if (!toggle)
            return;

        if (!this._device.isOpen && !this._device.open()) {
            toggle.visible = false;   // dongle not plugged in
            return;
        }

        try {
            // Battery + volume + balance in one request. Cheaper than asking separately.
            const bulk = await this._device.get(Proto.EV.STATUS_BULK);
            const noise = await this._device.get(Proto.EV.NOISE);
            // 0x24 is not in the bulk status and has to be asked for. The device
            // also reports it on its own (NTFY_ACTIVE) — this poll is a safety net.
            const mic = await this._device.get(Proto.EV.MIC_MUTE);
            toggle.updateBulk(Proto.decodeBulk(bulk.payload));
            toggle.updateNoise(Proto.decodeNoise(noise.payload));
            toggle.updateMic(Proto.decodeMicMuted(mic.payload));
            toggle.visible = true;
        } catch (e) {
            // The buds may be in the case / off; dongle plugged in but no answer.
            toggle.visible = false;
        }
    }
}
