#!/usr/bin/env python3
"""0x8C / 0x8D yetenek tablosu cozumleyici — DONANIMSIZ, capture dosyasindan calisir.

Girdi: query.py --sweep ciktisi (ornek captures/sweep-hi.txt). Ayni event_id'ye ait
ardisik cerceveler birlestirilir; iki event_id de cok parcali cevap veriyor.

Gramer — captures/sweep-hi.txt'teki her parcanin TAMAMINI tuketiyor (artan 0):

    [0..3]   cevap basligi 02 00 00 00
    parca:   <tur> <kayitlar...>            parcalar 01 00 10 ile ayriliyor
    BOLUM 1  <id> <count:LE16> <count x (slot, deger)>
    ayirac   <kendi kimligi>                 RX kopyasinda 0x71, TX'te 0x72
    BOLUM 2  <00> <count> ardindan <slot> <id> <len:LE16> <len-1 bayt>
    kapanis  BOLUM 1 grameriyle tek kayit, id=0xFF, hepsi sifir

slot uzayi her iki bolumde de ayni: {0x00, 0x01, 0x02, 0x07}.

⚠️ Parca ayirici desen olarak araniyor; ayni ucluyu tasiyan bir veri alani
cozumlemeyi bozar. Bugunku yakalamalarda boyle bir durum yok.
"""
import re
import sys

MARK = b"\x01\x00\x10"
H = lambda b: " ".join("%02x" % x for x in b)


def load(path, want):
    """Capture dosyasindan tek bir event_id'nin cerceverini birlestirir."""
    out = bytearray()
    for ln in open(path):
        m = re.match(r"^(\S+)\s+(\S+)\s+(\S+)\s+((?:[0-9a-f]{2} ?)+)", ln)
        if m and want.lower() in m.group(1).lower():
            out += bytes.fromhex(m.group(4).replace("<--", "").strip().replace(" ", ""))
    return bytes(out)


def group(buf, i):
    """BOLUM 1 kaydi: <id> <count:LE16> <count x (slot,deger)>."""
    eid, cnt = buf[i], buf[i + 1] | (buf[i + 2] << 8)
    pairs = [(buf[i + 3 + 2 * k], buf[i + 4 + 2 * k]) for k in range(cnt)]
    return eid, pairs, i + 3 + 2 * cnt


def is_group(buf, i):
    return i + 2 < len(buf) and buf[i + 1] == 4 and buf[i + 2] == 0


def parse(body, indent="    "):
    print("%stur           : %02x" % (indent, body[0]))
    i = 1
    while is_group(body, i):
        eid, pairs, i = group(body, i)
        print("%s  id=%02x  %s" % (indent, eid, "  ".join("%02x->%02x" % p for p in pairs)))

    if i < len(body):
        print("%skendi kimligi : %02x   (71=kulaklik / 72=dongle)" % (indent, body[i]))
        i += 1
        assert body[i] == 0, "beklenmeyen dolgu %02x" % body[i]
        n = body[i + 1]
        i += 2
        print("%sBOLUM 2 — slot basina event_id listesi (%d kayit)" % (indent, n))
        for _ in range(n):
            slot, eid = body[i], body[i + 1]
            ln = body[i + 2] | (body[i + 3] << 8)
            print("%s  slot=%02x id=%02x  [%s]" % (indent, slot, eid, H(body[i + 4 : i + 3 + ln])))
            i += 3 + ln
        eid, pairs, i = group(body, i)
        print("%skapanis       : id=%02x  %s" % (indent, eid, "  ".join("%02x->%02x" % p for p in pairs)))
    return len(body) - i


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "captures/sweep-hi.txt"
    rc = 0
    for want in ("0x8C", "0x8D"):
        blob = load(path, want)
        if not blob:
            continue
        print("== %s — %d bayt birlestirildi" % (want, len(blob)))
        parts = blob[4:].split(MARK)
        if len(parts) > 1:
            print("   %d parca (01 00 10 ayiraci)" % len(parts))
        if len(parts) == 2 and len(parts[0]) == len(parts[1]):
            d = [k for k in range(len(parts[0])) if parts[0][k] != parts[1][k]]
            print("   iki parcanin farkli baytlari: %s" % (d or "yok"))
        for k, part in enumerate(parts):
            print("   parca %d (%d bayt)" % (k + 1, len(part)))
            try:
                left = parse(part)
                print("    artan: %d%s" % (left, "  <-- GRAMER TUTMADI" if left else ""))
                rc |= 1 if left else 0
            except (AssertionError, IndexError) as e:
                print("    cozulemedi: %s" % e)
                rc = 1
        print()
    return rc


if __name__ == "__main__":
    sys.exit(main())
