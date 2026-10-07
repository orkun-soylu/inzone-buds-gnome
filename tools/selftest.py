#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Tests sniff.py's parser against synthetic frames (no hardware needed)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sniff import parse, describe_payload, addr_str  # noqa: E402
from query import build_command, ADDR_PC_TO_RX, ETYPE_GET  # noqa: E402
from parse_desc import parse as parse_desc  # noqa: E402


def build_event(event_id, event_type, payload, tid=1, address=0x14):
    """Build a device->PC EVENT frame following the H5 frame layout."""
    n = 12 + len(payload)
    buf = bytearray(64)
    buf[0] = 0x02                    # report id
    buf[1] = n                       # hid_length
    buf[2] = 0x04                    # HCI_TYPE_EVENT
    buf[3] = 0xFF                    # sony event code
    buf[4] = 8 + len(payload)        # param_length
    buf[5] = 0x00                    # dummy
    buf[6], buf[7] = 0x96, 0xC3      # sony key
    buf[8] = address                 # (dst<<4)|src ; 0x14 = RX->PC
    buf[9] = event_id
    buf[10] = event_type
    buf[11] = tid & 0xFF
    buf[12] = (tid >> 8) & 0xFF
    buf[13:13 + len(payload)] = payload
    buf[n + 1] = sum(buf[5:n + 1]) & 0xFF
    return bytes(buf)


fails = []


def check(label, cond, detail=""):
    print("  %s %s%s" % ("OK  " if cond else "FAIL", label, ("  <- " + detail) if detail and not cond else ""))
    if not cond:
        fails.append(label)


print("1) Buds battery frame (right 80%, left 75%, case 60%)")
frame = build_event(0x04, 0xA0, bytes([0x00, 80, 0x00, 75, 0x00, 60]))
check("hid_length = 0x12 (the byte[1] HeadsetControl sees)", frame[1] == 0x12,
      "0x%02x" % frame[1])
check("byte[2] = 0x04 (what HeadsetControl takes for 'BATTERY_SUBTYPE')", frame[2] == 0x04)
check("right=byte[14], left=byte[16], case=byte[18] (HeadsetControl offsets)",
      frame[14] == 80 and frame[16] == 75 and frame[18] == 60)
check("checksum at byte[19] (HeadsetControl's position)", frame[1] + 1 == 19)

kind, info = parse(frame)
check("parse() recognised a Sony frame", kind == "sony", str(info))
if kind == "sony":
    check("event_id = 0x04 BATTERY_INFO", info["event_id"] == 0x04)
    check("event_type = 0xA0 NTFY_ACTIVE", info["event_type"] == 0xA0)
    check("checksum verified", info["checksum_ok"], str(info["checksum"]))
    check("address direction RX->PC", addr_str(info["address"]) == "RX->PC", addr_str(info["address"]))
    note = describe_payload(0x04, info["payload"])
    check("battery reading", note == "battery: right=80%, left=75%, case=60%", repr(note))

print("\n2) Charging / absent / status-unknown labels")
kind, info = parse(build_event(0x04, 0xA0, bytes([0x01, 90, 0x00, 88, 0x00, 0xFF])))
note = describe_payload(0x04, info["payload"])
check("charging + no case", note == "battery: right=90% (charging), left=88%, case=absent", repr(note))

# REAL MEASUREMENT (buds in the ears, case apart):
#   GET BATTERY_INFO -> RET tid=2 payload=00 63 00 63 ff 64
# The case's STATUS byte is 0xFF -> not "charging" but unknown.
kind, info = parse(build_event(0x04, 0x10, bytes.fromhex("00630063ff64"), tid=2))
note = describe_payload(0x04, info["payload"])
check("real captured frame",
      note == "battery: right=99%, left=99%, case=100% (status unknown)", repr(note))
check("real frame is RET(0x10) with tid=2", info["event_type"] == 0x10 and info["tid"] == 2)

print("\n3) H5-style 2-byte battery payload")
kind, info = parse(build_event(0x04, 0x10, bytes([0x00, 55])))
check("2-byte payload parses too", describe_payload(0x04, info["payload"]) == "battery: 55%")

print("\n4) game/chat balance")
kind, info = parse(build_event(0x22, 0x10, bytes([40])))
check("balance reading", describe_payload(0x22, info["payload"]).startswith("game/chat balance = 40"))

print("\n5) Corrupt frames are rejected")
bad = bytearray(build_event(0x04, 0xA0, bytes([0, 80, 0, 75, 0, 60])))
bad[6] = 0x00  # corrupt sony key
check("wrong sony key rejected", parse(bytes(bad))[0] is None)
bad2 = bytearray(build_event(0x04, 0xA0, bytes([0, 80, 0, 75, 0, 60])))
bad2[19] ^= 0xFF  # corrupt checksum
k, i = parse(bytes(bad2))
check("corrupt checksum caught", k == "sony" and not i["checksum_ok"])
check("empty report rejected", parse(bytes(64))[0] is None)

print("\n6) Checksum range discovery")
kind, info = parse(frame)
check("buf[5..N] is among the matching ranges", 5 in info["checksum_matching_ranges"],
      str(info["checksum_matching_ranges"]))

print("\n7) build_command layout (must match H5 buildCommand)")
cmd = build_command(ADDR_PC_TO_RX, 0x04, ETYPE_GET, tid=2)
check("hid_length = 12 (no payload)", cmd[1] == 12, "%d" % cmd[1])
check("hci_type = 0x01 COMMAND", cmd[2] == 0x01)
check("opcode = 0xFC00 (LE: 00 FC)", cmd[3] == 0x00 and cmd[4] == 0xFC)
check("param_length = 8", cmd[5] == 8)
check("sony key = 96 C3", cmd[6] == 0x96 and cmd[7] == 0xC3)
check("address = 0x41 (PC->RX)", cmd[8] == 0x41)
check("event_id / event_type", cmd[9] == 0x04 and cmd[10] == 0x01)
check("tid LE", cmd[11] == 2 and cmd[12] == 0)
check("checksum at buf[13]", cmd[13] == (sum(cmd[6:13]) & 0xFF), "0x%02x" % cmd[13])
check("report is exactly 64 bytes", len(cmd) == 64)
cmd_p = build_command(ADDR_PC_TO_RX, 0x23, 0x02, tid=5, payload=bytes([25, 0xFF]))
check("with payload: hid_length = 14", cmd_p[1] == 14)
check("with payload: checksum at buf[15]", cmd_p[15] == (sum(cmd_p[6:15]) & 0xFF))
check("payload in place", cmd_p[13] == 25 and cmd_p[14] == 0xFF)

print("\n8) HID descriptor parser")
desc = bytes([0x06, 0x04, 0xFF, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x02,
              0x75, 0x08, 0x95, 0x3F, 0x09, 0x03, 0x81, 0x02,
              0x09, 0x04, 0x91, 0x02, 0xC0])
cols = parse_desc(desc)
check("one top-level collection", len(cols) == 1, str(cols))
if cols:
    up, ug, reports = cols[0]
    check("usage_page = 0xFF04", up == 0xFF04, "0x%04X" % up)
    check("usage = 0x0002", ug == 0x0002)
    check("report id 0x02 found", 2 in reports, str(reports))
    if 2 in reports:
        check("Input = 63 byte", reports[2].get("In") == 63 * 8, str(reports[2]))
        check("Output = 63 byte (writing possible)", reports[2].get("Out") == 63 * 8, str(reports[2]))

print("\n" + "=" * 60)
if fails:
    print("FAILED: %d tests" % len(fails))
    for f in fails:
        print("  - %s" % f)
    sys.exit(1)
print("All tests passed.")
