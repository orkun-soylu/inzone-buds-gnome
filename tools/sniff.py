#!/usr/bin/env python3
"""
INZONE Buds dongle (054c:0ec2) pasif HID dinleyicisi.

SALT OKUMA. Cihaza tek byte yazmaz — dinlerken müzik dinlemeye devam edebilirsin.

Amaci hipotezi dogrulamak: dongle'in yolladigi cerceveler, HeadsetControl'un
INZONE H5 surucusunde belgelenen Sony vendor HCI-over-HID protokolu mu?

  [0]      report id = 0x02
  [1]      hid_length = 12 + len(payload)
  [2]      hci_type   0x01=COMMAND (host->cihaz) / 0x04=EVENT (cihaz->host)
  [3]      event code = 0xFF   (event yonunde)
  [4]      param_length
  [5]      dummy = 0x00
  [6..7]   sony key  = 96 C3   (0xC396 LE)
  [8]      address = (dst<<4)|src   1=PC 2=TX(dongle) 4=RX(kulaklik)
  [9]      event_id
  [10]     event_type  01=GET 02=SET 10=RET 20=NTFY A0=NTFY_ACTIVE
  [11..12] transaction id (LE)
  [13..hid_length]  payload
  [hid_length+1]    checksum = sum(buf[5..hid_length]) & 0xFF

Kullanim:
  sudo ./tools/sniff.py                 # 30 sn dinle
  sudo ./tools/sniff.py -s 120 --raw    # 2 dk, eslesmeyen cerceveleri de goster
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

# H5 surucusunden bilinenler + 2026-09-02 taramasinda buds'ta kesfedilenler.
# Sonunda "?" olan isimler TAHMIN — payload'dan cikarildi, dogrulanmadi.
EVENT_ID = {
    0x01: "2GHZ_CONNECT_STATUS",
    0x02: "DEVICE_INFO?",       # icinde ASCII firmware surumu x3 (sol/sag/kutu)
    0x03: "CAPABILITY?",        # 3 x "03 00 40 00" — cihaz basina sabit
    0x04: "BATTERY_INFO",
    0x05: "DONGLE_STATE?",      # sadece TX cevapliyor, tek byte
    0x06: "STATUS_BULK?",       # batarya + ses + balance tek cevapta
    0x07: "STATUS_BULK2?",      # icinde noise control (0x41) payload'i var
    0x08: "UNKNOWN_08",
    0x09: "UNKNOWN_09",
    0x21: "HEADPHONE_VOLUME",
    0x22: "GAME_CHAT_MIX_BALANCE",
    0x23: "SIDETONE_VOLUME",
    0x24: "MIC_MUTE",
    0x41: "NOISE_CONTROL",      # ANC/kapali/ambient + ambient seviyesi (0-20)
    0x42: "UNKNOWN_42",
    0x43: "UNKNOWN_43",
}
EVENT_TYPE = {0x01: "GET", 0x02: "SET", 0x10: "RET", 0x20: "NTFY", 0xA0: "NTFY_ACTIVE"}
ADDR = {0x1: "PC", 0x2: "TX", 0x4: "RX"}


def addr_str(a):
    return "%s->%s" % (ADDR.get(a & 0xF, "?%X" % (a & 0xF)),
                       ADDR.get(a >> 4, "?%X" % (a >> 4)))


def find_nodes():
    """054c:0ec2'ye ait hidraw node'lari; (yol, vendor_ff04_mi, desc_boyut)."""
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
    """Sony HCI cercevesini coz. (kind, dict) veya (None, sebep)."""
    if buf[0] != REPORT_ID:
        return None, "report id 0x%02x (beklenen 0x02)" % buf[0]
    hid_length = buf[1]
    if not (12 <= hid_length <= REPORT_SIZE - 2):
        return None, "hid_length %d araligin disinda" % hid_length
    hci_type = buf[2]
    if hci_type not in (HCI_COMMAND, HCI_EVENT):
        return None, "hci_type 0x%02x" % hci_type
    if hci_type == HCI_EVENT and buf[3] != SONY_EVENT_CODE:
        return None, "event code 0x%02x (beklenen 0xFF)" % buf[3]
    if buf[6] != KEY_LO or buf[7] != KEY_HI:
        return None, "sony key %02x%02x (beklenen 96c3)" % (buf[6], buf[7])

    payload = bytes(buf[13:hid_length + 1]) if hid_length > 12 else b""
    got = buf[hid_length + 1]
    want = sum(buf[5:hid_length + 1]) & 0xFF
    # HeadsetControl'un buds surucusu farkli (ampirik) bir formul veriyor.
    # Hangi toplama araliginin gozlenen byte'i urettigini olcelim.
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
    """Bilinen event'ler icin insan-okur yorum."""
    if event_id == 0x04:
        # 0xFF her iki alanda da "bilinmiyor" sentinel'i.
        # Olculdu (2026-09-02): kulakliklar takiliyken kutunun durum byte'i 0xFF.
        def one(st, pct):
            if pct == 0xFF:
                return "yok"
            suffix = ""
            if st == 0xFF:
                suffix = " (durum bilinmiyor)"
            elif st:
                suffix = " (sarj)"
            return "%d%%%s" % (pct, suffix)

        if len(p) == 6:  # buds: (durum, yuzde) x 3
            return "batarya: " + ", ".join(
                "%s=%s" % (lab, one(p[2 * i], p[2 * i + 1]))
                for i, lab in enumerate(("sag", "sol", "kutu")))
        if len(p) == 2:  # H5 sekli
            return "batarya: %s" % one(p[0], p[1])
    if event_id == 0x41 and len(p) >= 2:
        # ESLEME kullanici tarafindan cihaz uzerinde DOGRULANDI (2026-09-03):
        #   mod 0 -> kapali
        #   mod 1 -> ANC
        #   mod 2 -> ambient
        # 2026-09-02'deki dinleme testi 0'i ANC sanmisti (kapali moddaki pasif
        # yalitim yaniltti); 1 ise "iki ucun arasinda" diye cikarilmisti. Ikisi
        # de yanlisti, duzeltildi.
        # byte[1] = ambient seviyesi, Sony araligi 0-20 (0x14 = tavan).
        mode = {0: "kapali", 1: "ANC", 2: "ambient"}.get(p[0], "bilinmeyen-%d" % p[0])
        return "gurultu kontrolu: %s, ambient seviyesi=%d/20" % (mode, p[1])
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
            return "metin alanlari: %s" % ", ".join(repr(r) for r in runs)
    if event_id == 0x06 and len(p) >= 13:
        # OLCULDU: 04 | batarya(6) | ses(3) | balance(1) | ? (2)
        bat = describe_payload(0x04, p[1:7])
        return "toplu durum: %s | ses=%d | balance=%d | kuyruk=%s" % (
            bat.replace("batarya: ", "batarya "), p[8], p[10], p[11:].hex(" "))
    if event_id == 0x22 and p:
        return "game/chat balance = %d (0=full chat, 100=full game)" % p[0]
    if event_id == 0x21 and len(p) >= 2:
        # OLCULDU: ses tusuna basinca ikinci byte 1c -> 1d -> 1e ilerledi
        return "ses seviyesi = %d" % p[1]
    if event_id == 0x24 and p:
        # OLCULDU: dokun-ve-tut ile byte[0] 00<->01; byte[1..2] hep 0xFF.
        # Seviye degil, mute anahtari. 0 = acik, 1 = kapali.
        return "mikrofon = %s" % ("KAPALI" if p[0] else "acik")
    if event_id == 0x23 and p:
        return "seviye = %s" % " ".join("%d" % b for b in p)
    if event_id == 0x01 and p:
        return "2.4GHz baglanti durumu = %s" % p.hex()
    return None


def main():
    ap = argparse.ArgumentParser(description="INZONE Buds dongle pasif HID dinleyicisi (salt okuma)")
    ap.add_argument("-n", "--node", help="hidraw node'unu elle sec")
    ap.add_argument("-s", "--seconds", type=float, default=30.0, help="dinleme suresi (varsayilan 30)")
    ap.add_argument("--raw", action="store_true", help="Sony cercevesi olmayanlari da bas")
    args = ap.parse_args()

    if args.node:
        node = args.node
    else:
        nodes = find_nodes()
        if not nodes:
            sys.exit("HATA: %04x:%04x icin hidraw node yok. Dongle takili mi?" % (VID, PID))
        print("Bulunan node'lar:")
        for path, is_vendor, dsize in nodes:
            print("  %-14s desc=%3dB %s" % (path, dsize, "<- vendor 0xFF04" if is_vendor else ""))
        vendor = [n for n in nodes if n[1]]
        if not vendor:
            sys.exit("\nHATA: hicbir node'da 0xFF04 vendor collection yok.\n"
                     "Hipotez burada zaten yanlis olabilir. probe.sh ciktisini paylas,\n"
                     "ya da --node ile tek tek dene.")
        node = vendor[0][0]
        print("\nSecilen: %s" % node)

    try:
        fd = os.open(node, os.O_RDONLY | os.O_NONBLOCK)
    except PermissionError:
        sys.exit("HATA: %s icin izin yok. 'sudo' ile calistir." % node)
    except OSError as e:
        sys.exit("HATA: %s acilamadi: %s" % (node, e))

    print("Dinleniyor %.0f sn... (Ctrl-C ile bitir)\n" % args.seconds)
    print("Ipucu: bu sirada kulaklikta ANC modunu degistir, ses seviyesini oynat,\n"
          "bir kulakligi kutuya koy — hangi event_id'nin degistigi boylece gorunur.\n")

    seen = Counter()
    samples = OrderedDict()   # (event_id, event_type) -> ilk cerceve ozeti
    cksum_ranges = Counter()  # buf[lo..N] toplami gozlenen checksum'i kac kez verdi
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
                    print("[%s] SONY-DEGIL (%s): %s" % (ts, info, buf[:24].hex(" ")))
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
        print("\n(kesildi)")
    finally:
        os.close(fd)

    print("\n" + "=" * 72)
    print("OZET  —  %d rapor okundu" % total)
    print("=" * 72)
    if not seen:
        print("Hic Sony cercevesi cozulemedi.")
        print("  - non-Sony rapor sayisi: %d" % non_sony)
        print("  - --raw ile tekrar calistirip ham byte'lari paylas.")
        return
    print("%-26s %-16s %8s" % ("EVENT_ID", "EVENT_TYPE", "adet"))
    for (eid, etype), n in sorted(seen.items()):
        star = "" if eid in EVENT_ID else "   <-- YENI, H5'te yok"
        print("%-26s %-16s %8d%s" % (
            "%s(0x%02X)" % (EVENT_ID.get(eid, "UNKNOWN"), eid),
            "%s(0x%02X)" % (EVENT_TYPE.get(etype, "?"), etype), n, star))
    print("\ncozulen: %d   checksum hatasi: %d   sony-degil: %d" %
          (sum(seen.values()), bad_checksum, non_sony))
    always = [lo for lo, n in cksum_ranges.items() if n == cksum_frames] if cksum_frames else []
    if always:
        print("checksum: her cercevede tutan toplama araligi -> %s" %
              ", ".join("buf[%d..N]" % lo for lo in sorted(always)))

    if bad_checksum == 0 and seen:
        print("\nSONUC: checksum'lar H5 formuluyle (buf[5..N]) tutuyor")
        print("        -> cerceveleme INZONE H5 protokolu ile AYNI. Hipotez dogrulandi.")
    elif always:
        print("\nSONUC: cerceve H5'e uyuyor, checksum farkli aralikta (yukarida).")
        print("        Protokol ayni, sadece sabitlerden biri kaymis. Hipotez buyuk olcude dogrulandi.")
    elif seen:
        print("\nSONUC: cerceve eslesiyor ama hicbir toplama araligi checksum'i uretmiyor.")
        print("        Ham cikti gerekli: --raw ile tekrar calistir ve sonucu paylas.")


if __name__ == "__main__":
    main()
