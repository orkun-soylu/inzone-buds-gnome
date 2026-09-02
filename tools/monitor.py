#!/usr/bin/env python3
"""
INZONE Buds durum izleyici — bir ayari degistir, hangi byte'in degistigini gor.

Dongle'a periyodik GET yollar (salt okuma), gelen NTFY push'larini da yakalar ve
bir event_id'nin payload'i DEGISTIGINDE eski/yeni farkini basar. Semantigi
cikarmanin en hizli yolu: bunu calistir, kulaklikta tek bir ayari degistir, farka bak.

Kullanim:
  sudo ./tools/monitor.py                    # varsayilan event_id kumesi
  sudo ./tools/monitor.py -e 0x41,0x06       # sadece bunlari izle
  sudo ./tools/monitor.py --push-only        # GET yollama, sadece push dinle
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sniff import EVENT_ID, EVENT_TYPE, find_nodes, describe_payload, addr_str  # noqa: E402
from query import build_command, drain, ADDR_PC_TO_RX, ADDR_PC_TO_TX, ETYPE_GET  # noqa: E402

# Tarama sonucunda cevap veren, durum tasiyan event_id'ler
DEFAULT_EVENTS = [0x04, 0x06, 0x07, 0x08, 0x21, 0x22, 0x23, 0x24, 0x41, 0x42, 0x43]


def name_of(eid):
    return "%s(0x%02X)" % (EVENT_ID.get(eid, "UNKNOWN"), eid)


def diff(old, new):
    """Degisen byte indekslerini ve eski->yeni degerlerini anlat."""
    if len(old) != len(new):
        return "uzunluk %d -> %d" % (len(old), len(new))
    return ", ".join("byte[%d] %02x->%02x" % (i, a, b)
                     for i, (a, b) in enumerate(zip(old, new)) if a != b)


def main():
    ap = argparse.ArgumentParser(description="INZONE Buds durum degisikligi izleyici")
    ap.add_argument("-n", "--node")
    ap.add_argument("-e", "--events", help="virgullu event_id listesi, or: 0x41,0x06")
    ap.add_argument("-i", "--interval", type=float, default=1.0, help="poll araligi (sn)")
    ap.add_argument("-t", "--timeout", type=float, default=0.25, help="cevap bekleme (sn)")
    ap.add_argument("--push-only", action="store_true", help="GET yollama, sadece dinle")
    ap.add_argument("--address", choices=["rx", "tx"], default="rx")
    args = ap.parse_args()

    events = ([int(x, 0) for x in args.events.split(",")] if args.events else DEFAULT_EVENTS)
    address = ADDR_PC_TO_RX if args.address == "rx" else ADDR_PC_TO_TX

    node = args.node
    if not node:
        nodes = [n for n in find_nodes() if n[1]]
        if not nodes:
            sys.exit("HATA: 0xFF04 vendor node bulunamadi.")
        node = nodes[0][0]

    try:
        fd = os.open(node, os.O_RDWR | os.O_NONBLOCK)
    except PermissionError:
        sys.exit("HATA: izin yok, 'sudo' ile calistir.")

    print("Node: %s   izlenen: %s" % (node, ", ".join(name_of(e) for e in events)))
    print("\nSimdi TEK bir ayari degistir. Fiziksel dugme yok, dokunmatik panel var:")
    print("  SOL kulaklik, tek dokunus  -> gurultu engelleme <-> ambient gecisi (0x41)")
    print("  SAG kulaklik, tek dokunus  -> ses yukselt (0x21)")
    print("  SAG kulaklik, dokun ve tut -> ses azalt")
    print("Degisen byte'lar asagida cikacak. Ctrl-C ile bitir.\n")

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
            print("           DEGISTI: %s" % diff(old, new))
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
                    print("  0x%02X yazma hatasi: %s" % (eid, e))
                    continue
                for info in drain(fd, args.timeout):
                    record(info, tag="" if info["event_type"] != 0xA0 else "   [push]")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n(bitti)")
    finally:
        os.close(fd)

    print("\nSon durum:")
    for eid in sorted(state):
        note = describe_payload(eid, state[eid])
        print("  %-26s %s" % (name_of(eid), state[eid].hex(" ") or "-"))
        if note:
            print("  %-26s -> %s" % ("", note))


if __name__ == "__main__":
    main()
