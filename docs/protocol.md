# Sony INZONE dongle protocol — what is known

Source: `Sapd/HeadsetControl`, `lib/devices/sony_inzone_h5.hpp` (the full protocol)
and `lib/devices/sony_inzone_buds.hpp` (a naive listener).

Everything below marked *measured* was observed on a real WF-G700N and its
dongle (2026-09); the dates are when it was measured.

## Transport

USB dongle, HID. The control channel is the **vendor collection on usage page
`0xFF04`, usage `0x0002`** (H5) / `0x0001` (buds). Report ID `0x02`, 64 bytes.
No feature reports or ioctls — plain interrupt in/out, so `read()`/`write()` on
`/dev/hidrawN` is enough.

| Device | VID:PID |
|---|---|
| INZONE Buds (WF-G700N) | `054c:0ec2` |
| INZONE H5 (WH-G500) | `054c:0ebf` |

## Frame

The Sony vendor layer sits on top of Bluetooth HCI as a thin wrapper. The host
sends COMMANDs with opcode `0xFC00`, the dongle answers with the `0xFF` vendor
event code.

```
[0]      report id   = 0x02
[1]      hid_length  = 12 + len(payload)
[2]      hci_type    = 0x01 COMMAND (host->device) | 0x04 EVENT (device->host)
[3]      COMMAND: opcode lo = 0x00   |  EVENT: event code = 0xFF
[4]      COMMAND: opcode hi = 0xFC   |  EVENT: param_length
[5]      COMMAND: param_length       |  EVENT: dummy = 0x00
[6..7]   sony key = 96 C3   (0xC396 LE)
[8]      address = (dst<<4) | src      1=PC  2=TX(dongle)  4=RX(earbuds)
[9]      event_id
[10]     event_type
[11..12] transaction id (LE)
[13..]   payload
[N+1]    checksum        N = hid_length
```

⚠️ `[3..5]` mean different things in the COMMAND and EVENT directions — which is
why HeadsetControl's `buildCommand` and `parseEvent` are not symmetric.

**Checksum — one rule: `sum(buf[6..N]) & 0xFF`, stored at `buf[N+1]`.**

The H5 driver uses `sum(buf[5..N])` on the read side and that works too, but only
because `buf[5]` is a zero dummy in EVENT frames. In COMMAND frames `buf[5]` is
`param_length` (non-zero) and starting there gives the **wrong** result.
Measured (2026-09-02), a real SET that was sent:

```
02 10 01 00 fc 0c 96 c3 41 41 02 02 00 | 00 14 ff 00 | f2
                └── buf[6] ───────────────────────┘    checksum
```

`sum(buf[6..16]) = 0xF2` ✓ · `sum(buf[5..16]) = 0xFE` ✗ (would not be accepted).

## event_type

| Value | Meaning |
|---|---|
| `0x01` | GET |
| `0x02` | SET |
| `0x10` | RET — reply to a GET |
| `0x20` | NTFY — reply to a SET |
| `0xA0` | NTFY_ACTIVE — sent by the device on its own (TID=1) |

Match TIDs when sending GET/SET. **Never use TID 0 or 1** — the dongle's own
pushes carry TID=1, and reusing it makes a push look like a reply.

## event_id map

From a `--sweep 0x00-0x43` (2026-09-02, PC→RX and PC→TX). `?` = guess.

| ID | Name | Observed payload | Notes |
|---|---|---|---|
| `0x01` | 2GHZ_CONNECT_STATUS | `01 01` (TX) | the dongle answers, not the buds |
| `0x02` | DEVICE_INFO? | `04 02 ff ff ff 00` + `"1020113"`×3 + `01 01` | ASCII firmware version, left/right/case |
| `0x03` | CAPABILITY? | `03 00 40 00` × 3 | a constant triple per device |
| `0x04` | BATTERY_INFO | `00 63 00 62 ff 64` | `[status, %] × (right, left, case)` |
| `0x05` | DONGLE_STATE? | `00` (TX) | |
| `0x06` | **STATUS_BULK?** | `04 · 00 63 00 62 ff 64 · 00 1c ff · 32 · 00 ff` | **battery + volume + balance in one reply** |
| `0x07` | STATUS_BULK2? | `00 ff ff 01 14 ff 00 01 01 01` | contains the `0x41` payload (`01 14 ff 00`) |
| `0x08` | — | `03 ff ff ff ff 0f ff 00 01 00` | |
| `0x09` | — | `00` (RX and TX) | |
| `0x21` | HEADPHONE_VOLUME | `00 1c ff` | **byte[1] = volume**; the button moved it `1c→1d→1e` |
| `0x22` | GAME_CHAT_MIX_BALANCE | `32` (=50) | **0..100**, `0` = game muted — see below |
| `0x23` | SIDETONE? | `00 ff` | `byte[0]` writable, `byte[1]` not — see below |
| `0x24` | **MIC_MUTE** | `00 ff ff` | **not** a level but a mute switch — see below |
| `0x41` | **NOISE_CONTROL** | `01 14 ff 00` | `[mode, ambient_level, ff, 00]` — see below |
| `0x42` | — | `01 01 01` | |
| `0x43` | — | `03` | |

### Touch controls (Sony defaults)

There are no physical buttons. Default assignments that apply through the dongle:

| Gesture | Left | Right |
|---|---|---|
| Single tap | noise cancelling ↔ ambient → `0x41` | volume up → `0x21` |
| Touch and hold | microphone mute → `0x24` (measured) | volume down |
| Double / triple tap | does nothing on the dongle | does nothing on the dongle |

The assignments can be changed in INZONE Hub / Sony Sound Connect, so this
mapping must live behind some `event_id` too (not found yet).

### Writing verified (2026-09-02)

`SET` → the device answers `NTFY(0x20)` with the same TID, then a verifying
`GET` reads the new state. Worked in both directions:

```
-> PC->RX NOISE_CONTROL(0x41) SET  tid=2  payload=00 14 ff 00
<- RX->PC NOISE_CONTROL(0x41) NTFY tid=2  payload=00 14 ff 00     (off)
-> PC->RX NOISE_CONTROL(0x41) GET  tid=3
<- RX->PC NOISE_CONTROL(0x41) RET  tid=3  payload=00 14 ff 00
```

Reading and writing are both confirmed; nothing in the protocol blocks a control
panel.

### `0x41` NOISE_CONTROL — solved

Payload: `[mode, ambient_level, 0xFF, 0x00]`

| mode | meaning | basis |
|---|---|---|
| `0` | off | confirmed on the device (2026-09-03) |
| `1` | ANC (noise cancelling) | confirmed on the device (2026-09-03) |
| `2` | ambient (ambient sound) | listening + confirmed on the device — right from the start |

A single tap on the left bud cycles the three: `2 → 0 → 1 → …`
(ambient → off → ANC → …)

`byte[1]` = ambient level, Sony's range **0–20**; the measured `0x14` = 20 is the
maximum. `byte[2]` = `0xFF` placeholder (same pattern on the H5), `byte[3]` = `0x00`.

⚠️ **Correction (2026-09-03):** `0` and `1` were first recorded the wrong way
round. A listening test on 2026-09-02 took mode `0` for ANC because "no outside
sound came through" — the buds seal well and their passive isolation sounds like
ANC; mode `1` had been inferred as "somewhere in between". Both were wrong; the
mapping was then confirmed on the device itself.
**Lesson:** don't try to tell the modes apart by ear, confirm through the
device's own UI — passive isolation is easily mistaken for ANC.

**`0x06` matters for the extension:** it returns battery, volume and balance in a
single round trip. The Quick Settings poll uses it instead of five separate GETs.

⚠️ **Pushes arrive independently of queries and carry `tid=1`.** During a sweep
they easily land in between and get attributed to the wrong `event_id` — always
file an incoming frame under **its own** `event_id`, not the one that was asked
for. (`query.py` made this mistake once; it is fixed.)

### `0x22` GAME_CHAT_MIX_BALANCE — direction and ceiling measured (2026-09-03)

The payload is one byte. The dongle presents two separate USB audio streams to
the computer (game + chat); this value is the mix ratio inside the earbuds.

**A real crossfade** — it does not turn one stream down, it trades the two off
against each other. Both streams were listened to separately (2026-09-03):

| value | game stream (`hw:2,0`) | chat stream (`hw:2,1`) |
|---|---|---|
| `0` | silent | full level |
| `100` | full level | too quiet to hear |
| `50` | resting value — also in the first capture (inside `0x06`) | |

Basis: the game side played by Spotify (a PipeWire sink), the chat side played
straight from ALSA with `speaker-test -D plughw:2,1 -c 2 -t sine`. `SET 0x64` was
also accepted with `NTFY` plus a verifying GET.

⚠️ **The earlier record was wrong in two ways** ("0..90, `0` = all game"):

- **The ceiling is 100, not 90.** `SET 0x22 = 0x64` → `NTFY` payload `64`, and the
  verifying GET also returned `64`; the device did not clamp it. `90` was carried
  over from the H5 protocol and never measured on this device. A resting value of
  `50` also fits 0–100 — the middle of 0–90 would be `45`.
- **The direction is inverted.** `0` is not the game end, it is the end that
  **mutes** the game stream.

**Why the evidence is conclusive:** during the measurement Spotify's stream was
connected to `INZONE Buds:playback_FL/FR` in PipeWire, and on Linux the dongle
had a **single** sink (`alsa_output.usb-Sony_INZONE_Buds-00.iec958-stereo`). So
"maybe it was on the chat device" is ruled out; the stream being turned down was
the game stream.

**The second PCM is the chat stream (measured).** `aplay -l` shows two playback
devices on the card: `card 2: Buds, device 0` — which PipeWire uses
(`Subdevices: 0/1` = busy) — and `device 1`, idle. Playing directly to `device 1`
with `speaker-test` behaved in **exactly the opposite** direction to the game
stream; the table above comes from that measurement.

**PipeWire does not open `device 1` as a sink by default.** WirePlumber's ACP
profile gives a single sink, so the chat stream is only reachable from ALSA
directly and the balance slider acts as a "turn everything down" control. The
fix is the Pro Audio profile — see `linux-audio.md` and `make wireplumber`.

**Quantisation: steps of 10, enforced (measured 2026-09-03).** Values that are
not multiples of 10 are **silently rejected** — no error, no snapping; the
`NTFY` simply returns the old value:

| SET | `NTFY` | result |
|---|---|---|
| `0x37` (55) | `0x64` (100) | rejected, value unchanged |
| `0x32` (50) | `0x32` (50) | accepted |
| `0x64` (100) | `0x64` (100) | accepted |

The second row is the **control experiment**: it ran in the same session, so
`0x37`'s rejection cannot be explained away as "the SET path was dead at the
time". (The same pattern settled `0x89`.)

Consequence: rounding to 10 in `extension.js` is **required**. Without it most
slider positions would silently do nothing — the kind of bug a user describes as
"sometimes it works, sometimes it doesn't".

### `0x23` — partly measured, meaning **still unknown** (2026-09-03)

| byte | state | basis |
|---|---|---|
| `byte[0]` | writable, persistent (`00` ↔ `01`) | `SET 01 ff` → verifying GET `01 ff`; going back to `00` held too |
| `byte[1]` | **not writable**, reverts to `0xFF` | `SET 01 0a` → `NTFY 01 0a` but the verifying GET says **`01 ff`** |

So like `0x24`: no level field, `byte[0]` is a switch. **But which switch could
not be determined** — set to `01`, nothing audible changed in the earbuds while
talking. The dongle never answers this event (`-a tx` is empty); the setting
lives in the earbuds.

**The "you can't hear it because the mic isn't open" hypothesis was RULED OUT
(2026-09-03).** It was repeated during a live Google Meet call — microphone and
headphones set to the INZONE, the red microphone indicator visible in the GNOME
panel:

- Starting the call did not change `0x23` (`00 ff`, the same) — the device does
  not keep call state in this event
- `byte[1]` could not be written during the call either (`SET 01 14` → GET
  `01 ff`), so it is not a conditional field
- `byte[0]` was toggled `00` ↔ `01` a few times while talking, with **no audible
  difference**

Conclusion: a writable, persistent switch with an unknown function. The name
`SIDETONE`, like `MIC_VOLUME`, is inherited from the H5 — unverified, hence the
`?` in the table. Nothing was added to the code.

⚠️ **An `NTFY` echo is NOT proof of acceptance.** This event showed it plainly:
for `SET 01 0a` the `NTFY` echoed the command's payload (`01 0a`), but the device
did not keep it — the GET right after said `01 ff`. The only authority is the
**verifying GET**. (The rejected `55` on `0x22` behaved differently: there the
`NTFY` returned the old value, not the command. So a rejection has no single
signature.)

In light of this rule the `0x41`, `0x22` and `0x24` results were reviewed: in all
of them the verifying GET returned the same value, so none of them is shaken.

### `0x24` — not MIC_VOLUME but a **mute switch** (2026-09-03)

The payload is three bytes, but only `byte[0]` moves:

| `byte[0]` | meaning | basis |
|---|---|---|
| `0` | microphone live | the input level meter moves while talking |
| `1` | microphone muted | the meter is dead |

`byte[1]` and `byte[2]` stayed `0xFF` throughout — there is no level field. The
change arrives as an `NTFY_ACTIVE` / `tid=1` push, so when the user mutes from the
earbud the panel learns about it without waiting for a poll.

**Method:** with `monitor.py -e 0x24` running, touch-and-hold on the left bud,
repeated four times; each time `byte[0]` flipped `00 ↔ 01`. The polarity was
pinned down separately by watching the audio input level.

**SET is accepted (2026-09-03).** With the device at `01`, `SET 00 ff ff` →
`NTFY` `00 ff ff`, and the verifying GET says `00` too. So unlike `0x89` it is not
read-only.

⚠️ **The first SET attempt proved nothing** and was nearly written down as
"works": `SET 01 ff ff` was sent while the device was already at `01`, and the
`NTFY` came back `01`. But on `0x22` the rejected `55` **also** got an `NTFY`
with a value — the current one. So "I got back the value I wrote" is proof only
when the written value **differs** from the old one. Rule: always test a SET with
a value different from the current one.

⚠️ **The name `MIC_VOLUME` was a wrong label inherited from the H5.** In `0x21`
(`00 1c ff`) `byte[1]` is a real level, seen moving `1c→1d→1e` with the button;
`0x24` has a constant `0xFF` in the same position. Assuming "that's a level too"
from the similar name would have been the same mistake as with `0x41` and `0x22`
— this time it was caught before reaching the code. `0x23` SIDETONE shows the same
`0xFF` pattern; **it has not been measured.**

## Field findings (2026-09-02) — PROTOCOL CONFIRMED

Dongle `054c:0ec2` → `/dev/hidraw6`, report descriptor 158 bytes.

**Confirmed exchange:**

```
-> PC->RX  BATTERY_INFO(0x04)  GET  tid=2
<- RX->PC  BATTERY_INFO(0x04)  RET  tid=2  payload=00 63 00 63 ff 64
```

The buds speak the **same** Sony vendor HCI protocol as the H5. Confirmed: frame
layout, the `0xC396` key, the address nibbles, GET→RET semantics, TID matching
and the checksum.

**Checksum, write direction: `sum(buf[6..12+len(payload)]) & 0xFF`** (i.e.
`--cksum-lo 6`, the same as the H5's `buildCommand`). It worked first time.

⚠️ **The dongle does broadcast on its own — but only when the state CHANGES.**

The first reading (2026-09-02) was "it never broadcasts": three minutes of passive
listening while music played produced *zero* reports. **Correction
(2026-09-03):** nothing had changed in that window. During a sweep this arrived
unasked:

```
BATTERY_INFO(0x04)  NTFY_ACTIVE(0xA0)  tid=1  payload=00 55 00 54 ff 64
```

The battery had dropped from `86/85` to `85/84`. `NTFY_ACTIVE` + `tid=1` is the
push signature.

In practice: the push path is **real**, the extension's `pushed` signal is not
dead code. But the events are rare and unpredictable — a design that relies on
passive listening does not work, polling is required. HeadsetControl's "the
dongle sends unsolicited HID reports" is right but incomplete: it does, just
rarely.

### Battery payload (6 bytes, measured)

`[status, percent] × (right, left, case)`. **`0xFF` = unknown** in both fields.

The captured `00 63 00 63 ff 64` → right 99%, left 99%, case 100%, but the case's
*status* byte is `0xFF`: with the buds out, the case is not connected to the
dongle, so its charging state is unknown. Reading `0xFF` as "charging" is wrong.

### HID report descriptor — five collections

| usage_page | usage | report | direction / size | notes |
|---|---|---|---|---|
| `0xFF04` | `0x0001` | `0x02` | In 63B, Out 63B | **control channel** (confirmed) |
| `0xFF13` | `0x0001` | `0x06` / `0x07` | Out 61B / In 61B | a second bidirectional vendor channel, unknown |
| `0x000C` | `0x0001` | `0x0C` | In 1B | Consumer — touch media keys |
| `0xFF03` | `0x0020` | `0xA0` / `0xA1` | Feat 34B / 22B | feature reports, probably device identity |
| `0xFF01` | `0x0020` | `0xB0` | In 7B | 7 usages (`0x25`–`0x2B`), maybe status/buttons |

Raw descriptor:

```
0613ff0901a101150026ff00850609007508953d9102850709007508953d8102c0
050c0901a101850c1500250109e909ea09e209cd09b509b6750195068102090095028102c0
0604ff0901a101150026ff0085027508953f0902810209039102c0
0603ff0920a101092185a0150026ff0075089522b102092285a19516b102c0
0601ff0920a10185b009250926092709280929092a092b750895078102c0
```

⚠️ The H5 driver says usage `0x0002` for `0xFF04`, the buds have usage `0x0001`.
Pick the vendor collection by **usage_page**, not by usage.

## The `0x8x` block — a capability/description table

In a `--sweep 0x44-0xff` only the `0x8x` range answered:

| ID | payload | note |
|---|---|---|
| `0x81` | `0f` | |
| `0x83` | `00` | |
| `0x84` | `01` | |
| `0x85` | `00` | |
| `0x86` | `05 01 02 04 00 01 02 04` | two groups, possibly a mode list |
| `0x87` | `00 00 01 00` | |
| `0x89` | `00 00 00 00 00 00` | **read-only** — does not answer a SET, not an EQ |
| `0x8C` | 2×112 bytes, **multi-part** | capability table — **solved**, see below |
| `0x8D` | 2×12 bytes | the same grammar as `0x8C`, a two-record abbreviation |
| `0x8E` | `00` | |

### `0x8C` / `0x8D` solved (2026-09-03, from the capture — no hardware)

`tools/parse_caps.py` re-parses the capture. The grammar's test of correctness is
strict: it leaves **0 bytes over in all four** parts.

```
$ ./tools/parse_caps.py captures/sweep-hi.txt
```

⚠️ **Multi-part reply:** several frames arrive back to back with the same `tid`
(the payload limit is 50 bytes). A client that reads one frame and stops gets
half the data. Parts are separated by `01 00 10` — those three bytes are
**framing**, not table content. (`0x8D` has the same separator; its 31 bytes are
complete, not truncated.)

```
[0..3]     reply header  02 00 00 00
part       <kind> <records…>             between parts  01 00 10
SECTION 1  <id> <count:LE16> <count × (slot, value)>
separator  <own identity>
SECTION 2  <00> <count>, then  <slot> <id> <len:LE16> <len-1 bytes>
trailer    one record in SECTION 1 grammar, id=0xFF, all zero
```

`0x8C` decoded (both parts have the same content):

| section | content |
|---|---|
| SECTION 1 | `id=00` → `00:01 01:00 02:00 07:70` · `id=10` → `00:23 01:00 02:00 07:24` · `id=70` → `00:71 01:00 02:00 07:72` · `id=20` → `00:20 01:21 02:22 07:00` |
| own identity | `71` (PC→RX reply) / `72` (PC→TX reply) |
| SECTION 2 | slot `00`→id `23`, `01`→`24`, `02`→`01`, `07`→`70`; all four list `01 20 21 22 23 24 70 71 72` (only `07` has an extra `10` at the end) |
| trailer | `id=ff`, all four slots zero |

**Main finding — `0x70`/`0x71`/`0x72` are not settings but device identities.**
The two 112-byte parts differ in **exactly one** byte (offset 45): asked through
the earbuds it is `0x71`, through the dongle `0x72`. So that byte is a "who is
answering" field. Record `id=70` has slot `00` pointing at `71` and slot `07` at
`72` — consistent with itself. This explains **why `0x70`–`0x72` don't answer a
plain GET**: they are not events to query but an addressing field.

⚠️ **The `slot` space {`00`, `01`, `02`, `07`} is NOT the `event_id` space.** The
same numbers exist as real event_ids too (`0x01` 2GHZ_CONNECT_STATUS, `0x02`
DEVICE_INFO…); don't mix them up. The slots are shared by both sections.

⚠️ **The list is not "every supported event".** `01 20 21 22 23 24 70 71 72` lacks
`0x04` (battery), `0x06` (bulk status) and `0x41` (noise control), all measured
to work. The table covers only the audio-settings group — **EQ/spatial do not come
out of it**; they must be looked for elsewhere.

### `0x89` — tried, **not an EQ** (2026-09-03)

The hypothesis: six zero bytes, BudsLink has an `equalizerSixBands` flag, INZONE
Hub has an EQ → `0x89` could be a six-band EQ. **It turned out wrong.**

| attempt | result |
|---|---|
| `GET 0x89 -a rx` | `RET`, `00 00 00 00 00 00` |
| `SET 0x89 -a rx` payload `00×6` | **no reply** (twice) |
| `GET 0x89 -a tx` | no reply (all four checksum variants) |
| `SET 0x89 -a tx` payload `00×6` | no reply |
| **control:** `SET 0x41 -a rx` payload `02 12 ff 00` | `NTFY(0x20)` + verifying GET ✓ |

The last row decides it: **in the same session, on the same node and address,
with the same checksum rule**, a known event accepted a SET. So `0x89`'s silence
comes from `0x89` itself, not from the link — it can be read but not written.

The frame sent was checked too, it was not malformed:
`02 12 01 00 fc 0e 96 c3 41 89 02 02 00 · 00×6 · 27` — `hid_length`=12+6,
`param_length`=8+6, checksum = sum of `buf[6..18]` = 0x27. ✓

⚠️ **The one variant not tried: a different payload length.** Only 6 bytes were
tried (the length that was read). `0x89` may expect another length. But the `0x8C`
capability table does not include an EQ either, so there is no positive evidence
left that this protocol has one.

**Conclusion: no EQ candidate remains in the `0x8x` block.** EQ/spatial do not
appear on this vendor HCI channel; Sony must handle them through another
mechanism (a separate interface, or an endpoint only INZONE Hub uses).

## Why the buds are taken to speak the same protocol

HeadsetControl's buds driver does not know the protocol: it sends no commands,
only waits for the pattern `byte[1]==0x12 && byte[2]==0x04` and calls those
"BATTERY_TYPE / BATTERY_SUBTYPE". In an H5 frame those two are
**`hid_length`=18 and `HCI_TYPE_EVENT`**. `tools/selftest.py` shows that a battery
frame built from the H5 specification produces *every* constant in the buds driver
(offsets 14/16/18, checksum at 19).

The checksum formula in the buds driver's header, `(byte[14]+byte[16]+117) mod
256`, ignores the case byte — it was overfitted to observations rather than
written from knowledge of the protocol. That strengthens the case.

Sony's own documentation says EQ, Spatial Sound, DRC, game/chat balance and
microphone level work "only when connected with the USB transceiver" — so these
settings have to be on this channel somehow.

## Why there is no Bluetooth route

The INZONE Buds are **LE Audio only** (BT 5.3; TMAP/CSIP/MCP/VCP/CCP; LC3). There
is no Bluetooth Classic → no A2DP/HFP → **no RFCOMM**. The SPP protocol of Sony's
classic headphones (`96cc203e-…` v1 / `956c7b26-…` v2, used by `maniacx/BudsLink`
and the archived `Plutoberth/SonyHeadphonesClient`) **cannot be opened** on this
device. Adding a 27-line device config to BudsLink would not help.

## Measuring: rules learned the hard way

These three led protocol work to wrong conclusions more than once:

1. **An `NTFY` echo is NOT proof of acceptance.** The device can echo a value it
   rejected (`0x22`'s `55` was rejected yet got an `NTFY`). The only authority is
   the **GET sent afterwards**.
2. **Always test a SET with a DIFFERENT value.** An attempt that writes the
   current value proves nothing — exactly what happened with `0x24`.
3. **Don't trust names inherited from the H5 — measure.** `0x24` was thought to be
   "MIC_VOLUME" and is a mute switch; `0x22`'s range was thought to be 0–90 and is
   0–100 in enforced steps of 10; `0x41`'s mode mapping was read backwards. All
   three were unmeasured assumptions.

And two practical ones:

- **Disable the extension while measuring** (`gnome-extensions disable
  inzone@soylu.me`), or its own polls mix into the captures and before/after
  diffs become meaningless.
- **The first `--set` belongs on a known event_id** (such as `0x22`, which is easy
  to undo). Sending a SET to an arbitrary event_id can leave the device in an
  unknown state.
