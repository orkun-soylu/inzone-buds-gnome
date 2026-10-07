#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""HID report descriptor parser for the INZONE Buds dongle. Entirely passive."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sniff import find_nodes, VID, PID  # noqa: E402

MAIN, GLOBAL, LOCAL = 0, 1, 2
COLLECTION_KIND = {0: "Physical", 1: "Application", 2: "Logical", 3: "Report"}


def items(desc):
    """Decode HID short items -> (tag, type, data)."""
    i = 0
    while i < len(desc):
        b = desc[i]
        size = b & 0x03
        if size == 3:
            size = 4
        tag, typ = (b >> 4) & 0x0F, (b >> 2) & 0x03
        data = int.from_bytes(desc[i + 1:i + 1 + size], "little")
        yield tag, typ, data, size
        i += 1 + size


def parse(desc):
    """Extract the top-level collections and the I/O sizes per report ID."""
    usage_page = usage = report_id = 0
    size = count = 0
    depth = 0
    collections = []   # (usage_page, usage, {report_id: {"In":bits,"Out":bits,"Feat":bits}})
    cur = None

    for tag, typ, data, _n in items(desc):
        if typ == GLOBAL:
            if tag == 0x0:
                usage_page = data
            elif tag == 0x7:
                size = data
            elif tag == 0x8:
                report_id = data
            elif tag == 0x9:
                count = data
        elif typ == LOCAL:
            if tag == 0x0:
                usage = data
        elif typ == MAIN:
            if tag == 0xA:                      # Collection
                if depth == 0:
                    cur = (usage_page, usage, {})
                    collections.append(cur)
                depth += 1
            elif tag == 0xC:                    # End Collection
                depth -= 1
            elif tag in (0x8, 0x9, 0xB) and cur is not None:
                kind = {0x8: "In", 0x9: "Out", 0xB: "Feat"}[tag]
                slot = cur[2].setdefault(report_id, {})
                slot[kind] = slot.get(kind, 0) + size * count
    return collections


def main():
    nodes = find_nodes()
    if not nodes:
        sys.exit("  no hidraw node for %04x:%04x" % (VID, PID))

    for path, is_vendor, _n in nodes:
        sysdesc = "/sys/class/hidraw/%s/device/report_descriptor" % os.path.basename(path)
        try:
            with open(sysdesc, "rb") as f:
                desc = f.read()
        except OSError as e:
            print("  %s: cannot read the descriptor (%s)" % (path, e))
            continue

        print("  %s  (%d byte)%s" % (path, len(desc), "  <- vendor 0xFF04" if is_vendor else ""))
        for up, ug, reports in parse(desc):
            label = "VENDOR" if up >= 0xFF00 else "standard"
            print("    collection: usage_page=0x%04X usage=0x%04X  [%s]" % (up, ug, label))
            for rid in sorted(reports):
                parts = ", ".join(
                    "%s=%d byte" % (k, v // 8) for k, v in sorted(reports[rid].items()))
                print("      report id 0x%02X: %s" % (rid, parts))
        print("    raw: %s" % desc.hex())
        print()


if __name__ == "__main__":
    main()
