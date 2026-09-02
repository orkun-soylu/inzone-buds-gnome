// INZONE Buds — GNOME Quick Settings kontrolu.

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

const POLL_OPEN_MS = 2000;    // Quick Settings acikken
const POLL_CLOSED_MS = 10000; // kapaliyken
const DRAG_DEBOUNCE_MS = 220; // slider surukleme
const USER_HOLD_MS = 2000;    // suruklemeden sonra poll'un UI'yi ezmemesi icin

/** Slider iceren bir menu satiri — Quick Settings izgarasinda yer kaplamaz. */
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

    /** Cihazdan gelen degeri yaz — kendi 'notify' geri cagrimizi tetiklemeden. */
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

        this.menu.setHeader('audio-headphones-symbolic', _('INZONE Buds'));

        // --- gurultu kontrolu, uc durum
        this._modeItems = new Map();
        for (const [mode, label] of [
            [Proto.NOISE_ANC, _('Gürültü engelleme')],
            [Proto.NOISE_OFF, _('Kapalı')],
            [Proto.NOISE_AMBIENT, _('Ortam sesi')],
        ]) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._applyMode(mode));
            this.menu.addMenuItem(item);
            this._modeItems.set(mode, item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- ortam sesi seviyesi (0-20)
        this._ambientRow = new SliderRow('audio-input-microphone-symbolic', value => {
            this._lastUserAction = GLib.get_monotonic_time();
            const level = Math.round(value * Proto.AMBIENT_MAX);
            this._ambient = level;
            this._device.set(Proto.EV.NOISE, Proto.encodeNoise(this._mode, level))
                .catch(() => {});
        });
        this.menu.addMenuItem(this._ambientRow);

        // --- oyun / sohbet dengesi (0-90)
        this._balanceRow = new SliderRow('applications-games-symbolic', value => {
            this._lastUserAction = GLib.get_monotonic_time();
            // cihaz 10'ar adim bekliyor
            const step = Math.round(value * Proto.BALANCE_MAX / 10) * 10;
            this._device.set(Proto.EV.BALANCE, [step]).catch(() => {});
        });
        this.menu.addMenuItem(this._balanceRow);

        this.connect('clicked', () => {
            // Toggle = ANC acik/kapali. Ortam sesi menuden secilir.
            this._applyMode(this.checked ? Proto.NOISE_ANC : Proto.NOISE_OFF);
        });
    }

    /** Kullanici az once slider surukledi mi — poll onu ezmesin. */
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
        for (const [mode, item] of this._modeItems) {
            item.setOrnament(mode === this._mode
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        }
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
                : `S ${b.left ?? '–'}% · Sğ ${b.right ?? '–'}%`);
        // String.prototype.format'a guvenme — Shell kendi ortamina kuruyor ama
        // extension'in bagli olmasi gereken bir sozlesme degil.
        this.menu.setHeader('audio-headphones-symbolic', _('INZONE Buds'),
            low === null ? null : `${_('Pil')} ${low}%`);
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

        // Kulakliga dokunuldugunda cihaz kendiliginden bildiriyor — UI canli kalsin.
        this._pushId = this._device.connect('pushed', (_dev, eventId, info) => {
            if (eventId === Proto.EV.NOISE)
                this._indicator.toggle.updateNoise(Proto.decodeNoise(info.payload));
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
            toggle.visible = false;   // dongle takili degil
            return;
        }

        try {
            // Tek istekte batarya + ses + balance. Ayri ayri sormaktan ucuz.
            const bulk = await this._device.get(Proto.EV.STATUS_BULK);
            const noise = await this._device.get(Proto.EV.NOISE);
            toggle.updateBulk(Proto.decodeBulk(bulk.payload));
            toggle.updateNoise(Proto.decodeNoise(noise.payload));
            toggle.visible = true;
        } catch (e) {
            // Kulaklik kutuda / kapali olabilir; dongle takili ama cevap yok.
            toggle.visible = false;
        }
    }
}
