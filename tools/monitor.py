#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""
INZONE Buds state monitor — change a setting, see which byte changed.

Sends periodic GETs to the dongle (read only), also catches incoming NTFY pushes,
and prints the old/new difference WHENEVER an event_id's payload changes. The
quickest way to work out meaning: run this, change one setting on the buds,
look at the diff.

Usage:
  sudo ./tools/monitor.py                    # default event_id set
  sudo ./tools/monitor.py -e 0x41,0x06       # watch only these
  sudo ./tools/monitor.py --push-only        # send no GETs, only listen for pushes
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sniff import EVENT_ID, EVENT_TYPE, find_nodes, describe_payload, addr_str  # noqa: E402
from query import build_command, drain, ADDR_PC_TO_RX, ADDR_PC_TO_TX, ETYPE_GET  # noqa: E402

# event_ids that answered the sweep and carry state
DEFAULT_EVENTS = [0x04, 0x06, 0x07, 0x08, 0x21, 0x22, 0x23, 0x24, 0x41, 0x42, 0x43]


def name_of(eid):
    return "%s(0x%02X)" % (EVENT_ID.get(eid, "UNKNOWN"), eid)


def diff(old, new):
    """Describe the changed byte indices and their old->new values."""
    if len(old) != len(new):
        return "length %d -> %d" % (len(old), len(new))
    return ", ".join("byte[%d] %02x->%02x" % (i, a, b)
                     for i, (a, b) in enumerate(zip(old, new)) if a != b)


def main():
    ap = argparse.ArgumentParser(description="INZONE Buds state-change monitor")
    ap.add_argument("-n", "--node")
    ap.add_argument("-e", "--events", help="comma-separated event_ids, e.g. 0x41,0x06")
    ap.add_argument("-i", "--interval", type=float, default=1.0, help="poll interval (s)")
    ap.add_argument("-t", "--timeout", type=float, default=0.25, help="reply timeout (s)")
    ap.add_argument("--push-only", action="store_true", help="send no GETs, only listen")
    ap.add_argument("--address", choices=["rx", "tx"], default="rx")
    args = ap.parse_args()

    events = ([int(x, 0) for x in args.events.split(",")] if args.events else DEFAULT_EVENTS)
    address = ADDR_PC_TO_RX if args.address == "rx" else ADDR_PC_TO_TX

    node = args.node
    if not node:
        nodes = [n for n in find_nodes() if n[1]]
        if not nodes:
            sys.exit("ERROR: no 0xFF04 vendor node found.")
        node = nodes[0][0]

    try:
        fd = os.open(node, os.O_RDWR | os.O_NONBLOCK)
    except PermissionError:
        sys.exit("ERROR: permission denied, run with 'sudo'.")

    print("Node: %s   watching: %s" % (node, ", ".join(name_of(e) for e in events)))
    print("\nNow change ONE setting. There are no physical buttons, only touch panels:")
    print("  LEFT bud, single tap      -> noise cancelling <-> ambient (0x41)")
    print("  RIGHT bud, single tap     -> volume up (0x21)")
    print("  RIGHT bud, touch and hold -> volume down")
    print("Changed bytes will show up below. Ctrl-C to stop.\n")

    state = {}
    tid = 500

    def record(info, tag=""):
        eid = info["event_id"]
        new = info["payload"]
        old = state.get(eid)
        if old == new:
            return
        state[eid] = new
        ts = time.strftime("%H:%M:%S")
        note = describe_payload(eid, new)
        if old is None:
            print("[%s] %-26s %s%s" % (ts, name_of(eid), new.hex(" ") or "-", tag))
        else:
            print("[%s] %-26s %s%s" % (ts, name_of(eid), new.hex(" ") or "-", tag))
            print("           CHANGED: %s" % diff(old, new))
        if note:
            print("           -> %s" % note)

    try:
        while True:
            if args.push_only:
                for info in drain(fd, args.interval):
                    record(info, tag="   [push]")
                continue
            for eid in events:
                tid = 501 if tid > 0xFF00 else tid + 1
                try:
                    os.write(fd, build_command(address, eid, ETYPE_GET, tid))
                except OSError as e:
                    print("  0x%02X write error: %s" % (eid, e))
                    continue
                for info in drain(fd, args.timeout):
                    record(info, tag="" if info["event_type"] != 0xA0 else "   [push]")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n(done)")
    finally:
        os.close(fd)

    print("\nFinal state:")
    for eid in sorted(state):
        note = describe_payload(eid, state[eid])
        print("  %-26s %s" % (name_of(eid), state[eid].hex(" ") or "-"))
        if note:
            print("  %-26s -> %s" % ("", note))


if __name__ == "__main__":
    main()
