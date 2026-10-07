#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""
Sends a Sony vendor HCI command to the INZONE Buds dongle and waits for the reply.

This is the tool that WRITES to the device. The default is GET — a GET is
read-only by meaning and does not change the device's state. SET requires an
explicit --set.

Why it exists: passive listening gave zero reports in 3 minutes. The dongle only
broadcasts when something changes; as with the H5 driver, the host has to ask.

Usage:
  sudo ./tools/query.py                    # ask for the battery (0x04), try both addresses
  sudo ./tools/query.py -e 0x22            # ask for the game/chat balance
  sudo ./tools/query.py --scan             # sweep the known event_ids (all GET)
  sudo ./tools/query.py --raw              # print every incoming frame raw
"""

import argparse
import os
import select
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sniff import (REPORT_SIZE, REPORT_ID, EVENT_ID, EVENT_TYPE, KEY_LO, KEY_HI,  # noqa: E402
                   VID, PID, find_nodes, parse, describe_payload, addr_str)

HCI_COMMAND = 0x01
OPCODE_LO, OPCODE_HI = 0x00, 0xFC
ADDR_PC_TO_RX = 0x41   # (RX<<4)|PC — earbuds
ADDR_PC_TO_TX = 0x21   # (TX<<4)|PC — the dongle itself
ETYPE_GET, ETYPE_SET = 0x01, 0x02


def build_command(address, event_id, event_type, tid, payload=b"", cksum_lo=6):
    """Same layout as the H5 buildCommand."""
    n = len(payload)
    buf = bytearray(REPORT_SIZE)
    buf[0] = REPORT_ID
    buf[1] = 12 + n                 # hid_length
    buf[2] = HCI_COMMAND
    buf[3] = OPCODE_LO
    buf[4] = OPCODE_HI
    buf[5] = 8 + n                  # param_length
    buf[6], buf[7] = KEY_LO, KEY_HI
    buf[8] = address
    buf[9] = event_id
    buf[10] = event_type
    buf[11] = tid & 0xFF
    buf[12] = (tid >> 8) & 0xFF
    buf[13:13 + n] = payload
    buf[13 + n] = sum(buf[cksum_lo:13 + n]) & 0xFF
    return bytes(buf)


def drain(fd, seconds, raw=False, want=None):
    """Read for the given time; return the parsed frames."""
    got = []
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], max(0.0, end - time.time()))
        if not r:
            break
        try:
            data = os.read(fd, REPORT_SIZE)
        except BlockingIOError:
            continue
        except OSError as e:
            print("    read error: %s" % e)
            break
        if not data:
            continue
        buf = bytes(data).ljust(REPORT_SIZE, b"\x00")
        kind, info = parse(buf)
        if kind is None:
            if raw:
                print("    [not-sony: %s] %s" % (info, buf[:24].hex(" ")))
            continue
        got.append(info)
        note = describe_payload(info["event_id"], info["payload"])
        flag = "" if info["checksum_ok"] else "  !! checksum got=%02x want=%02x" % info["checksum"]
        print("    <- %-11s %-24s %-15s tid=%-5d payload=%s%s" % (
            addr_str(info["address"]),
            "%s(0x%02X)" % (EVENT_ID.get(info["event_id"], "UNKNOWN"), info["event_id"]),
            "%s(0x%02X)" % (EVENT_TYPE.get(info["event_type"], "?"), info["event_type"]),
            info["tid"], info["payload"].hex(" ") or "-", flag))
        if note:
            print("       -> %s" % note)
        if want is not None and info["event_id"] == want:
            break
    return got


def sweep(fd, addresses, lo, hi, timeout, raw=False, out=None):
    """Sweep an event_id range with GET. GET only — changes no state."""
    print("\nSweep: event_id 0x%02X..0x%02X, %s, GET, %.2f s/step"
          % (lo, hi, "/".join(addr_str(a) for a in addresses), timeout))
    print("(Ctrl-C prints the partial result)\n")

    found = {}   # event_id -> [(address, event_type, payload_hex)]
    tid = 100
    try:
        for event_id in range(lo, hi + 1):
            for address in addresses:
                tid += 1
                if tid > 0xFFF0:
                    tid = 100
                try:
                    os.write(fd, build_command(address, event_id, ETYPE_GET, tid))
                except OSError as e:
                    print("  0x%02X write error: %s" % (event_id, e))
                    continue
                for info in drain(fd, timeout, raw=raw):
                    # ⚠️ Record the frame under its OWN event_id, not the one ASKED for.
                    # The dongle's NTFY_ACTIVE pushes (tid=1) arrive independently of
                    # the query; filing them under the loop variable corrupts the map.
                    got_id = info["event_id"]
                    solicited = info["event_type"] != 0xA0 and got_id == event_id
                    found.setdefault(got_id, []).append(
                        (address if solicited else None,
                         info["event_type"], info["payload"].hex(" ")))
    except KeyboardInterrupt:
        print("\n(sweep interrupted)")

    lines = []
    lines.append("%-24s %-9s %-17s %s" % ("EVENT_ID", "address", "event_type", "payload"))
    lines.append("-" * 78)
    for event_id in sorted(found):
        seen_rows = set()
        for address, etype, phex in found[event_id]:
            row = (address, etype, phex)
            if row in seen_rows:
                continue
            seen_rows.add(row)
            name = EVENT_ID.get(event_id)
            lines.append("%-24s %-9s %-17s %s%s" % (
                "%s(0x%02X)" % (name or "UNKNOWN", event_id),
                addr_str(address) if address is not None else "push",
                "%s(0x%02X)" % (EVENT_TYPE.get(etype, "?"), etype),
                phex or "-",
                "" if name else "   <-- NEW"))
    body = "\n".join(lines)
    print("\n" + "=" * 78)
    print("SWEEP RESULT — %d event_ids answered" % len(found))
    print("=" * 78)
    print(body)
    new = [e for e in found if e not in EVENT_ID]
    print("\nknown: %d   new: %d" % (len(found) - len(new), len(new)))
    if new:
        print("new event_ids: %s" % ", ".join("0x%02X" % e for e in sorted(new)))

    if out:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w") as f:
            f.write("# INZONE Buds event_id sweep 0x%02X..0x%02X\n\n" % (lo, hi))
            f.write(body + "\n")
        print("\nsaved: %s" % out)
    return found


def main():
    ap = argparse.ArgumentParser(description="Send GET/SET to the INZONE Buds dongle")
    ap.add_argument("-n", "--node")
    ap.add_argument("-e", "--event", default="0x04",
                    help="event_id (default 0x04 BATTERY_INFO)")
    ap.add_argument("-a", "--address", choices=["rx", "tx", "both"], default="both")
    ap.add_argument("-t", "--timeout", type=float, default=2.0,
                    help="reply timeout (s); 0.3-0.4 is enough for a sweep")
    ap.add_argument("--cksum-lo", type=int, default=None,
                    help="checksum summation start (default 6; 4-7 are tried when there is no reply)")
    ap.add_argument("--scan", action="store_true", help="GET every known event_id in turn")
    ap.add_argument("--sweep", metavar="RANGE", nargs="?", const="0x00-0xff",
                    help="sweep an event_id range with GET (default 0x00-0xff)")
    ap.add_argument("--out", help="write the sweep result to this file")
    ap.add_argument("--raw", action="store_true")
    ap.add_argument("--set", dest="do_set", action="store_true",
                    help="send SET instead of GET (CHANGES STATE)")
    ap.add_argument("--payload", default="", help="hex payload for SET, e.g. '00 20'")
    args = ap.parse_args()

    if args.node:
        node = args.node
    else:
        nodes = [n for n in find_nodes() if n[1]]
        if not nodes:
            sys.exit("ERROR: no 0xFF04 vendor node found for %04x:%04x." % (VID, PID))
        node = nodes[0][0]
    print("Node: %s" % node)

    if args.do_set:
        print("\n!! SET mode — this CHANGES the device's state.\n")

    try:
        fd = os.open(node, os.O_RDWR | os.O_NONBLOCK)
    except PermissionError:
        sys.exit("ERROR: permission denied, run with 'sudo'.")
    except OSError as e:
        sys.exit("ERROR: cannot open %s: %s" % (node, e))

    addresses = {"rx": [ADDR_PC_TO_RX], "tx": [ADDR_PC_TO_TX],
                 "both": [ADDR_PC_TO_RX, ADDR_PC_TO_TX]}[args.address]

    if args.sweep:
        lo_s, _, hi_s = args.sweep.partition("-")
        try:
            lo, hi = int(lo_s, 0), int(hi_s or lo_s, 0)
        except ValueError:
            sys.exit("ERROR: cannot parse the --sweep range: %r (e.g. 0x00-0xff)" % args.sweep)
        if args.do_set:
            sys.exit("ERROR: sweeps are GET only and cannot be combined with --set.")
        try:
            sweep(fd, addresses, lo, hi, args.timeout, raw=args.raw, out=args.out)
        finally:
            os.close(fd)
        return
    events = sorted(EVENT_ID) if args.scan else [int(args.event, 0)]
    payload = bytes.fromhex(args.payload.replace(" ", "")) if args.payload else b""
    etype = ETYPE_SET if args.do_set else ETYPE_GET
    if args.cksum_lo is not None:
        cksums = [args.cksum_lo]
    elif args.do_set:
        # The write checksum is verified on the device (buf[6..N]). A SET should
        # not be repeated with wrong checksums — one attempt.
        cksums = [6]
    else:
        cksums = [6, 5, 4, 7]

    tid = 1
    answered = False
    try:
        for event_id in events:
            name = EVENT_ID.get(event_id, "UNKNOWN")
            for address in addresses:
                for cl in cksums:
                    tid += 1
                    cmd = build_command(address, event_id, etype, tid, payload, cl)
                    n = cmd[1]
                    print("\n-> %s %s(0x%02X) %s  tid=%d cksum_lo=%d" % (
                        addr_str(address), name, event_id,
                        "SET" if args.do_set else "GET", tid, cl))
                    if args.raw or args.do_set:
                        print("   raw: %s" % cmd[:n + 2].hex(" "))
                    try:
                        os.write(fd, cmd)
                    except OSError as e:
                        print("   write error: %s" % e)
                        continue
                    got = drain(fd, args.timeout, raw=args.raw, want=event_id)
                    if got:
                        answered = True
                        print("   (got a reply — cksum_lo=%d works)" % cl)
                        if args.do_set:
                            # After a SET, GET to see whether it really changed.
                            tid += 1
                            print("\n-> verifying GET %s(0x%02X) tid=%d" % (name, event_id, tid))
                            os.write(fd, build_command(address, event_id, ETYPE_GET, tid, b"", cl))
                            drain(fd, args.timeout, raw=args.raw, want=event_id)
                        break
                    print("   (no reply)")
                if answered and not args.scan:
                    break
            if answered and not args.scan:
                break
    except KeyboardInterrupt:
        print("\n(interrupted)")
    finally:
        os.close(fd)

    print("\n" + "=" * 60)
    if answered:
        print("RESULT: the dongle answers commands. Protocol confirmed.")
    else:
        print("RESULT: no combination got a reply.")
        print("  Things to try:")
        print("   - are the buds connected to the dongle and in your ears (not in the case)")
        print("   - sudo ./tools/query.py --scan --raw   (every event_id + raw output)")
        print("   - sudo ./tools/parse_desc.py           (is there really an output report)")


if __name__ == "__main__":
    main()
