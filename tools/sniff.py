#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""
Passive HID listener for the INZONE Buds dongle (054c:0ec2).

READ ONLY. It never writes a single byte to the device — safe to run while you
keep listening to music.

Its purpose was to test a hypothesis: are the frames the dongle sends the Sony
vendor HCI-over-HID protocol documented in HeadsetControl's INZONE H5 driver?

  [0]      report id = 0x02
  [1]      hid_length = 12 + len(payload)
  [2]      hci_type   0x01=COMMAND (host->device) / 0x04=EVENT (device->host)
  [3]      event code = 0xFF   (event direction)
  [4]      param_length
  [5]      dummy = 0x00
  [6..7]   sony key  = 96 C3   (0xC396 LE)
  [8]      address = (dst<<4)|src   1=PC 2=TX(dongle) 4=RX(earbuds)
  [9]      event_id
  [10]     event_type  01=GET 02=SET 10=RET 20=NTFY A0=NTFY_ACTIVE
  [11..12] transaction id (LE)
  [13..hid_length]  payload
  [hid_length+1]    checksum = sum(buf[5..hid_length]) & 0xFF

Usage:
  sudo ./tools/sniff.py                 # listen for 30 s
  sudo ./tools/sniff.py -s 120 --raw    # 2 min, also show non-matching frames
  sudo ./tools/sniff.py -n /dev/hidraw3
"""

import argparse
import os
import select
import sys
import time
from collections import Counter, OrderedDict

VID, PID = 0x054C, 0x0EC2
REPORT_SIZE = 64
REPORT_ID = 0x02
HCI_COMMAND, HCI_EVENT = 0x01, 0x04
SONY_EVENT_CODE = 0xFF
KEY_LO, KEY_HI = 0x96, 0xC3

# Known from the H5 driver + discovered on the buds by sweeping.
# Names ending in "?" are GUESSES — inferred from the payload, not verified.
EVENT_ID = {
    0x01: "2GHZ_CONNECT_STATUS",
    0x02: "DEVICE_INFO?",       # contains an ASCII firmware version x3 (left/right/case)
    0x03: "CAPABILITY?",        # 3 x "03 00 40 00" — constant per device
    0x04: "BATTERY_INFO",
    0x05: "DONGLE_STATE?",      # only TX answers, one byte
    0x06: "STATUS_BULK?",       # battery + volume + balance in one reply
    0x07: "STATUS_BULK2?",      # contains the noise control (0x41) payload
    0x08: "UNKNOWN_08",
    0x09: "UNKNOWN_09",
    0x21: "HEADPHONE_VOLUME",
    0x22: "GAME_CHAT_MIX_BALANCE",
    0x23: "SIDETONE_VOLUME",
    0x24: "MIC_MUTE",
    0x41: "NOISE_CONTROL",      # ANC/off/ambient + ambient level (0-20)
    0x42: "UNKNOWN_42",
    0x43: "UNKNOWN_43",
}
EVENT_TYPE = {0x01: "GET", 0x02: "SET", 0x10: "RET", 0x20: "NTFY", 0xA0: "NTFY_ACTIVE"}
ADDR = {0x1: "PC", 0x2: "TX", 0x4: "RX"}


def addr_str(a):
    return "%s->%s" % (ADDR.get(a & 0xF, "?%X" % (a & 0xF)),
                       ADDR.get(a >> 4, "?%X" % (a >> 4)))


def find_nodes():
    """hidraw nodes belonging to 054c:0ec2; (path, has_vendor_ff04, desc_size)."""
    out = []
    base = "/sys/class/hidraw"
    if not os.path.isdir(base):
        return out
    for name in sorted(os.listdir(base)):
        dev = os.path.join(base, name, "device")
        try:
            with open(os.path.join(dev, "uevent")) as f:
                uevent = f.read()
        except OSError:
            continue
        hid_id = ""
        for line in uevent.splitlines():
            if line.startswith("HID_ID="):
                hid_id = line.split("=", 1)[1].upper()
        if not hid_id.endswith(":%08X:%08X" % (VID, PID)):
            continue
        try:
            with open(os.path.join(dev, "report_descriptor"), "rb") as f:
                desc = f.read()
        except OSError:
            desc = b""
        out.append((os.path.join("/dev", name), b"\x06\x04\xff" in desc, len(desc)))
    return out


def parse(buf):
    """Parse a Sony HCI frame. (kind, dict) or (None, reason)."""
    if buf[0] != REPORT_ID:
        return None, "report id 0x%02x (expected 0x02)" % buf[0]
    hid_length = buf[1]
    if not (12 <= hid_length <= REPORT_SIZE - 2):
        return None, "hid_length %d out of range" % hid_length
    hci_type = buf[2]
    if hci_type not in (HCI_COMMAND, HCI_EVENT):
        return None, "hci_type 0x%02x" % hci_type
    if hci_type == HCI_EVENT and buf[3] != SONY_EVENT_CODE:
        return None, "event code 0x%02x (expected 0xFF)" % buf[3]
    if buf[6] != KEY_LO or buf[7] != KEY_HI:
        return None, "sony key %02x%02x (expected 96c3)" % (buf[6], buf[7])

    payload = bytes(buf[13:hid_length + 1]) if hid_length > 12 else b""
    got = buf[hid_length + 1]
    want = sum(buf[5:hid_length + 1]) & 0xFF
    # HeadsetControl's buds driver gives a different (empirical) formula.
    # Measure which summation range produces the observed byte.
    matching = [lo for lo in range(2, 13)
                if (sum(buf[lo:hid_length + 1]) & 0xFF) == got]
    return "sony", {
        "checksum_matching_ranges": matching,
        "hid_length": hid_length,
        "hci_type": hci_type,
        "address": buf[8],
        "event_id": buf[9],
        "event_type": buf[10],
        "tid": buf[11] | (buf[12] << 8),
        "payload": payload,
        "checksum_ok": got == want,
        "checksum": (got, want),
    }


def describe_payload(event_id, p):
    """Human-readable reading of known events."""
    if event_id == 0x04:
        # 0xFF is the "unknown" sentinel in both fields.
        # Measured: with the buds out of the case, the case's status byte is 0xFF.
        def one(st, pct):
            if pct == 0xFF:
                return "absent"
            suffix = ""
            if st == 0xFF:
                suffix = " (status unknown)"
            elif st:
                suffix = " (charging)"
            return "%d%%%s" % (pct, suffix)

        if len(p) == 6:  # buds: (status, percent) x 3
            return "battery: " + ", ".join(
                "%s=%s" % (lab, one(p[2 * i], p[2 * i + 1]))
                for i, lab in enumerate(("right", "left", "case")))
        if len(p) == 2:  # H5 layout
            return "battery: %s" % one(p[0], p[1])
    if event_id == 0x41 and len(p) >= 2:
        # Mapping VERIFIED on the device:
        #   mode 0 -> off
        #   mode 1 -> ANC
        #   mode 2 -> ambient
        # An earlier listening test took 0 for ANC (the passive isolation of
        # "off" was misleading) and inferred 1 as "somewhere in between". Both
        # were wrong and have been corrected.
        # byte[1] = ambient level, Sony's range 0-20 (0x14 = maximum).
        mode = {0: "off", 1: "ANC", 2: "ambient"}.get(p[0], "unknown-%d" % p[0])
        return "noise control: %s, ambient level=%d/20" % (mode, p[1])
    if event_id == 0x02:
        runs, cur = [], b""
        for b in p:
            if 0x20 <= b < 0x7F:
                cur += bytes([b])
            else:
                if len(cur) >= 4:
                    runs.append(cur.decode("ascii"))
                cur = b""
        if len(cur) >= 4:
            runs.append(cur.decode("ascii"))
        if runs:
            return "text fields: %s" % ", ".join(repr(r) for r in runs)
    if event_id == 0x06 and len(p) >= 13:
        # MEASURED: 04 | battery(6) | volume(3) | balance(1) | ? (2)
        bat = describe_payload(0x04, p[1:7])
        return "bulk status: %s | volume=%d | balance=%d | tail=%s" % (
            bat.replace("battery: ", "battery "), p[8], p[10], p[11:].hex(" "))
    if event_id == 0x22 and p:
        return "game/chat balance = %d (0=full chat, 100=full game)" % p[0]
    if event_id == 0x21 and len(p) >= 2:
        # MEASURED: pressing volume up moved the second byte 1c -> 1d -> 1e
        return "volume = %d" % p[1]
    if event_id == 0x24 and p:
        # MEASURED: touch-and-hold flips byte[0] 00<->01; byte[1..2] always 0xFF.
        # Not a level but a mute switch. 0 = live, 1 = muted.
        return "microphone = %s" % ("MUTED" if p[0] else "live")
    if event_id == 0x23 and p:
        return "level = %s" % " ".join("%d" % b for b in p)
    if event_id == 0x01 and p:
        return "2.4GHz link status = %s" % p.hex()
    return None


def main():
    ap = argparse.ArgumentParser(description="Passive HID listener for the INZONE Buds dongle (read only)")
    ap.add_argument("-n", "--node", help="pick the hidraw node by hand")
    ap.add_argument("-s", "--seconds", type=float, default=30.0, help="how long to listen (default 30)")
    ap.add_argument("--raw", action="store_true", help="also print frames that are not Sony frames")
    args = ap.parse_args()

    if args.node:
        node = args.node
    else:
        nodes = find_nodes()
        if not nodes:
            sys.exit("ERROR: no hidraw node for %04x:%04x. Is the dongle plugged in?" % (VID, PID))
        print("Nodes found:")
        for path, is_vendor, dsize in nodes:
            print("  %-14s desc=%3dB %s" % (path, dsize, "<- vendor 0xFF04" if is_vendor else ""))
        vendor = [n for n in nodes if n[1]]
        if not vendor:
            sys.exit("\nERROR: no node has the 0xFF04 vendor collection.\n"
                     "The hypothesis may already be wrong here. Share the probe.sh output,\n"
                     "or try the nodes one by one with --node.")
        node = vendor[0][0]
        print("\nSelected: %s" % node)

    try:
        fd = os.open(node, os.O_RDONLY | os.O_NONBLOCK)
    except PermissionError:
        sys.exit("ERROR: no permission for %s. Run with 'sudo'." % node)
    except OSError as e:
        sys.exit("ERROR: cannot open %s: %s" % (node, e))

    print("Listening for %.0f s... (Ctrl-C to stop)\n" % args.seconds)
    print("Tip: meanwhile change the ANC mode, adjust the volume, put an earbud\n"
          "in the case — that shows which event_id changes.\n")

    seen = Counter()
    samples = OrderedDict()   # (event_id, event_type) -> summary of the first frame
    cksum_ranges = Counter()  # how often the sum of buf[lo..N] gave the observed checksum
    cksum_frames = 0
    bad_checksum = 0
    non_sony = 0
    total = 0
    deadline = time.time() + args.seconds

    try:
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], min(0.5, max(0.0, deadline - time.time())))
            if not r:
                continue
            try:
                data = os.read(fd, REPORT_SIZE)
            except BlockingIOError:
                continue
            if not data:
                continue
            total += 1
            buf = bytes(data).ljust(REPORT_SIZE, b"\x00")
            kind, info = parse(buf)
            ts = time.strftime("%H:%M:%S")

            if kind is None:
                non_sony += 1
                if args.raw:
                    print("[%s] NOT-SONY (%s): %s" % (ts, info, buf[:24].hex(" ")))
                continue

            if not info["checksum_ok"]:
                bad_checksum += 1
            for lo in info["checksum_matching_ranges"]:
                cksum_ranges[lo] += 1
            cksum_frames += 1

            eid, etype = info["event_id"], info["event_type"]
            seen[(eid, etype)] += 1
            key = (eid, etype)

            line = "[%s] %-11s %-22s %-11s tid=%-5d payload=%s%s" % (
                ts,
                addr_str(info["address"]),
                "%s(0x%02X)" % (EVENT_ID.get(eid, "UNKNOWN"), eid),
                "%s(0x%02X)" % (EVENT_TYPE.get(etype, "?"), etype),
                info["tid"],
                info["payload"].hex(" ") or "-",
                "" if info["checksum_ok"] else "  !! CHECKSUM got=%02x want=%02x" % info["checksum"],
            )
            note = describe_payload(eid, info["payload"])
            if key not in samples:
                samples[key] = line
                print(line + ("\n              -> " + note if note else ""))
            elif note:
                print(line + "\n              -> " + note)
            else:
                print(line)
    except KeyboardInterrupt:
        print("\n(interrupted)")
    finally:
        os.close(fd)

    print("\n" + "=" * 72)
    print("SUMMARY  —  %d reports read" % total)
    print("=" * 72)
    if not seen:
        print("No Sony frame could be parsed.")
        print("  - non-Sony reports: %d" % non_sony)
        print("  - run again with --raw and share the raw bytes.")
        return
    print("%-26s %-16s %8s" % ("EVENT_ID", "EVENT_TYPE", "count"))
    for (eid, etype), n in sorted(seen.items()):
        star = "" if eid in EVENT_ID else "   <-- NEW, not in the H5"
        print("%-26s %-16s %8d%s" % (
            "%s(0x%02X)" % (EVENT_ID.get(eid, "UNKNOWN"), eid),
            "%s(0x%02X)" % (EVENT_TYPE.get(etype, "?"), etype), n, star))
    print("\nparsed: %d   checksum errors: %d   not-sony: %d" %
          (sum(seen.values()), bad_checksum, non_sony))
    always = [lo for lo, n in cksum_ranges.items() if n == cksum_frames] if cksum_frames else []
    if always:
        print("checksum: summation range that matched every frame -> %s" %
              ", ".join("buf[%d..N]" % lo for lo in sorted(always)))

    if bad_checksum == 0 and seen:
        print("\nRESULT: the checksums match the H5 formula (buf[5..N])")
        print("        -> the framing is the SAME as the INZONE H5 protocol. Hypothesis confirmed.")
    elif always:
        print("\nRESULT: the frame matches the H5, the checksum uses a different range (above).")
        print("        Same protocol, one constant has shifted. Hypothesis largely confirmed.")
    elif seen:
        print("\nRESULT: the frame matches but no summation range produces the checksum.")
        print("        Raw output needed: run again with --raw and share the result.")


if __name__ == "__main__":
    main()
