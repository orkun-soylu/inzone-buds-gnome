# Linux audio side — splitting game and chat

This file is not about the protocol but about **the audio configuration the
earbuds need to work properly on Linux**. For the protocol → `protocol.md`.

## The problem

The dongle presents **two playback PCMs** to the computer:

```
card 2: Buds [INZONE Buds], device 0: USB Audio        → game stream
card 2: Buds [INZONE Buds], device 1: USB Audio #1     → chat stream
```

The earbuds mix the two internally, and the mix ratio is adjustable over the
vendor HCI (`0x22 GAME_CHAT_MIX_BALANCE`, see `protocol.md`). This is the
"Game/Chat Balance" slider of INZONE Hub on Windows.

**But none of ALSA's default ACP profiles open both PCMs.** Of the seven profiles
in `pw-cli e <devid> EnumProfile`, six give a single sink; the one picked by
default is `output:iec958-stereo+input:mono-fallback`.

Result: no application can be routed to the chat stream, so the balance setting
does not balance two streams — it turns one down. Moving the slider left just
lowers the volume.

## The fix: the `pro-audio` profile

The seventh profile (`pro-audio`, index 5) lists **two** devices under
`Audio/Sink`. When it is selected:

| PipeWire node | ALSA | stream |
|---|---|---|
| `alsa_output.usb-Sony_INZONE_Buds-00.pro-output-0` | `hw:2,0` | **game** |
| `alsa_output.usb-Sony_INZONE_Buds-00.pro-output-1` | `hw:2,1` | **chat** |
| `alsa_input.usb-Sony_INZONE_Buds-00.pro-input-0` | — | microphone |

The mapping was read from the `api.alsa.path` field of `wpctl inspect <sink-id>`
— not guessed. Which PCM is which stream was also confirmed by ear
(`speaker-test -D plughw:2,1` is at full level with balance `0` and quiet at
`100`; Spotify on `hw:2,0` does the opposite). The card number (`2` here) depends
on the machine.

### Installing

```bash
make wireplumber
```

Copies `wireplumber/51-inzone-pro-audio.conf` to
`~/.config/wireplumber/wireplumber.conf.d/` and restarts WirePlumber. To check:

```bash
wpctl status | grep -i inzone     # TWO sinks should show up
```

### Why two layers

Making it stick was harder than expected; three things were tried:

| method | result |
|---|---|
| `wpctl set-profile <dev> 5` | works at that moment, **lost on replug** — never writes the state file |
| `wpctl set-default <sink>` | moves the default but does not pin the profile |
| config rule (`device.profile`) | **not enough on its own** — the saved state overrides it |

The decisive evidence: after the rule was installed the device was still on
`iec958`, and `~/.local/state/wireplumber/default-profile` carried this line:

```
alsa_card.usb-Sony_INZONE_Buds-00=output:iec958-stereo+input:mono-fallback
```

The file's timestamp was **older** than the `wpctl set-profile` call — that
command had never updated the state. Once the line was changed to `pro-audio`,
both sinks stayed up even after unplugging and replugging the dongle.

So `make wireplumber` does both: it installs the config file (so the profile is
picked on a clean machine with no saved state) **and** fixes the state line.
WirePlumber is stopped before the state is edited — edited while the service
runs, it writes the file back on exit and overwrites the change.

### Routing applications

GNOME's Sound panel gives per-application **volume** but not a per-application
**output device**. Two ways:

- **The application's own setting.** In Google Meet: gear → Audio → Speakers:
  `INZONE Buds Pro 1`. Discord, Zoom etc. have their own output picker too.
- **`pavucontrol`** — any stream can be moved from the Playback tab.

The default output should stay on the game stream (`pro-output-0`); only the
voice-chat application goes to the chat stream.

### ⚠️ **Four** INZONE entries appear in the list, two of them traps

With Pro Audio installed, GNOME's Sound Output list shows:

```
Analog Output – INZONE Buds            ← a route of the card, NOT a device
Digital Output (S/PDIF) – INZONE Buds  ← a route of the card, NOT a device
INZONE Buds Pro                        ← pro-output-0, game stream
INZONE Buds Pro 1                      ← pro-output-1, chat stream
```

But there are really **two** sinks. Measured:

- `wpctl status` → two sinks under INZONE (`Pro`, `Pro 1`) + one source
- `pw-cli e <devid> EnumRoute` → three routes: `Headset Microphone`,
  `Analog Output`, `Digital Output (S/PDIF)`

So two output routes + two nodes = the four lines in the list. The naming gives
it away too: GNOME writes entries that carry a port as `port – device` ("Speaker –
Alder Lake…" and so on); the bottom two have no dash because they are nodes.

**Don't touch the top two.** They are outputs belonging to the ACP profiles;
selecting one moves the card off `pro-audio` and the chat sink disappears.
*(That selecting a route switches the profile back was not tried directly — it
is an inference. If it happens, `make wireplumber` restores the setup.)*

Everyday use: keep the default output on **INZONE Buds Pro** and move only the
voice-chat application to **INZONE Buds Pro 1** in its own settings.

### Confirmed behaviour (2026-09-03)

With Google Meet on the chat stream and Spotify playing on the game stream, the
slider was moved to both ends: **far left, only the call**; moving right brings
the music in; far right, the music at full level. So `0x22` really crossfades
between the two streams and the Quick Settings slider does its job.

### The cost

The `pro-audio` profile disables ALSA's channel/format conversions and the ACP
mixer routing; volume becomes software volume. It caused no problems in everyday
use, but don't expect behaviour that comes from a hardware mixer.

The setup **survived a reboot** (2026-09-03) — a stronger check than unplugging
and replugging the dongle.

To undo: `make wireplumber-uninstall`
