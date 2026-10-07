# INZONE Buds — GNOME extension

Control **Sony INZONE Buds (WF-G700N)** from the **GNOME Quick Settings** menu
on Linux: battery level, noise cancelling / ambient sound, ambient sound level,
game/chat balance and microphone mute.

The earbuds speak LE Audio only — there is no Bluetooth Classic, so the existing
Linux tools for Sony headphones (BudsLink, SonyHeadphonesClient — both RFCOMM
SPP) cannot work with them. The only control channel is the USB-C dongle, over
HID. This extension talks to the dongle directly from GNOME Shell, in plain
JavaScript: no helper binary, no system package, nothing installed outside
`$HOME` except one udev rule.

```
~/.local/share/gnome-shell/extensions/inzone@soylu.me/
├── metadata.json
├── extension.js      ← Quick Settings UI
├── device.js         ← hidraw discovery and async I/O
└── protocol.js       ← the Sony vendor HCI frames

/etc/udev/rules.d/60-inzone.rules   ← the only privileged file
```

## Requirements

* GNOME Shell 48 (developed on Debian 13; Wayland or X11)
* Sony INZONE Buds with their USB-C dongle (`054c:0ec2`)
* `make` (and `zip`, only for `make pack`; `node` and `python3`, only for
  `make check`)

## Install

```bash
git clone https://github.com/orkun-soylu/inzone-buds-gnome.git
cd inzone-buds-gnome

make install    # installs into ~/.local/share/... (no sudo)
make udev       # installs the udev rule (sudo, once per machine)
```

Then **log out and back in** — Wayland cannot reload GNOME Shell in place — and
run `gnome-extensions enable inzone@soylu.me`. With the dongle plugged in and the
earbuds connected, an **INZONE Buds** tile appears in Quick Settings: the toggle
switches noise cancelling on and off, the subtitle shows the battery, and the
arrow on its right opens the rest.

The checkout can be deleted afterwards.

### Game / chat balance

The dongle exposes two audio outputs — a game stream and a chat stream — and the
earbuds mix them according to the balance slider. By default PipeWire opens only
one of them, which turns the slider into a plain volume control. To get both:

```bash
make wireplumber
```

This pins the dongle to WirePlumber's Pro Audio profile. Then send your
voice-chat application to **INZONE Buds Pro 1** and leave everything else on
**INZONE Buds Pro**. The details, and why it takes two steps, are in
[`docs/linux-audio.md`](docs/linux-audio.md).

### Removing it

```bash
make uninstall               # the extension
make udev-uninstall          # the udev rule (sudo)
make wireplumber-uninstall   # the Pro Audio pinning
```

## How it works

* The extension finds the dongle's hidraw node by vendor/product id and the
  `0xFF04` vendor usage page in its report descriptor, then exchanges 64-byte
  Sony vendor HCI frames with it — the same protocol as the INZONE H5 headset
  in [HeadsetControl](https://github.com/Sapd/HeadsetControl).
* One request (`0x06`) returns battery, volume and balance together; noise mode
  and microphone mute are asked for separately. The poll runs every 2 s while
  Quick Settings is open and every 10 s otherwise.
* When you tap an earbud, the dongle reports the change on its own and the menu
  follows it immediately.
* All I/O is asynchronous on the shell's main loop; nothing blocks GNOME Shell.
* `60-inzone.rules` tags the dongle's `hidraw` node with `uaccess`, so
  systemd-logind grants an ACL to the locally logged-in user. (The `60-` prefix
  matters: a rule sorted after systemd's `70-uaccess.rules` has no effect.)

## Troubleshooting

* **No tile.** Is the dongle plugged in and are the earbuds out of the case? The
  tile hides while the earbuds do not answer. `ls -l /dev/hidraw*` should show a
  `+` (an ACL) on the dongle's node; if not, run `make udev` and replug it.
  `journalctl -f -o cat /usr/bin/gnome-shell` shows the extension's errors.
* **The balance slider only changes the volume.** Run `make wireplumber` (above).
* **Balance moves in steps of 10.** The earbuds silently reject anything else.

## Protocol notes and tools

[`docs/protocol.md`](docs/protocol.md) documents what is known about the
protocol: the frame layout, the `event_id` map, how each value was measured, and
what is still unknown (EQ and spatial sound are not on this channel). The tools
used to work it out are in `tools/`:

| Tool | What it does |
|---|---|
| `probe.sh` | finds the dongle, its hidraw nodes and the vendor collection (read only) |
| `parse_desc.py` | decodes the HID report descriptor (read only) |
| `sniff.py` | passive listener; parses the frames the dongle sends (**never writes**) |
| `query.py` | sends GET (default) or `--set` commands; `--sweep` scans the event_id space |
| `monitor.py` | polls state and prints which byte changed when you change a setting |
| `parse_caps.py` | decodes the `0x8C`/`0x8D` capability table from a capture in `captures/` |
| `gjs-probe.js` | checks that GJS can read and write the hidraw node |
| `selftest.py`, `js-selftest.mjs` | protocol tests without hardware (`make check`) |

They need `sudo` (or the udev rule) to open the device. **Disable the extension
while measuring**, or its own polls show up in the captures. Use `--set` on a
known event_id first; writing to an arbitrary one can leave the earbuds in an
unknown state.

## License

GPL-2.0-or-later — see [`LICENSE`](LICENSE).

INZONE and Sony are trademarks of Sony Group Corporation. This project is not
affiliated with or endorsed by Sony.
