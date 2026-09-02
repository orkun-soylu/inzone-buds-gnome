#!/usr/bin/env python3
"""sniff.py cozumleyicisinin sentetik cercevelerle testi (donanim gerektirmez)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sniff import parse, describe_payload, addr_str  # noqa: E402


def build_event(event_id, event_type, payload, tid=1, address=0x14):
    """H5 cerceve duzenine gore bir cihaz->PC EVENT cercevesi kur."""
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


print("1) Buds batarya cercevesi (sag 80%, sol 75%, kutu 60%)")
frame = build_event(0x04, 0xA0, bytes([0x00, 80, 0x00, 75, 0x00, 60]))
check("hid_length = 0x12 (HeadsetControl'un gordugu byte[1])", frame[1] == 0x12,
      "0x%02x" % frame[1])
check("byte[2] = 0x04 (HeadsetControl'un 'BATTERY_SUBTYPE' sandigi)", frame[2] == 0x04)
check("sag=byte[14], sol=byte[16], kutu=byte[18] (HeadsetControl offsetleri)",
      frame[14] == 80 and frame[16] == 75 and frame[18] == 60)
check("checksum byte[19] (HeadsetControl'un konumu)", frame[1] + 1 == 19)

kind, info = parse(frame)
check("parse() cerceveyi Sony olarak tanidi", kind == "sony", str(info))
if kind == "sony":
    check("event_id = 0x04 BATTERY_INFO", info["event_id"] == 0x04)
    check("event_type = 0xA0 NTFY_ACTIVE", info["event_type"] == 0xA0)
    check("checksum dogrulandi", info["checksum_ok"], str(info["checksum"]))
    check("adres yonu RX->PC", addr_str(info["address"]) == "RX->PC", addr_str(info["address"]))
    note = describe_payload(0x04, info["payload"])
    check("batarya yorumu", note == "batarya: sag=80%, sol=75%, kutu=60%", repr(note))

print("\n2) Sarj + offline durumlari")
kind, info = parse(build_event(0x04, 0xA0, bytes([0x01, 90, 0x00, 0xFF, 0x01, 100])))
note = describe_payload(0x04, info["payload"])
check("sarj ve offline etiketleri", note == "batarya: sag=90% (sarj), sol=offline, kutu=100% (sarj)", repr(note))

print("\n3) H5 sekli 2-byte batarya payload'i")
kind, info = parse(build_event(0x04, 0x10, bytes([0x00, 55])))
check("2-byte payload da cozuluyor", describe_payload(0x04, info["payload"]) == "batarya: 55%")

print("\n4) game/chat balance")
kind, info = parse(build_event(0x22, 0x10, bytes([40])))
check("balance yorumu", describe_payload(0x22, info["payload"]).startswith("game/chat balance = 40"))

print("\n5) Bozuk cerceveler reddediliyor")
bad = bytearray(build_event(0x04, 0xA0, bytes([0, 80, 0, 75, 0, 60])))
bad[6] = 0x00  # sony key bozuk
check("yanlis sony key reddedildi", parse(bytes(bad))[0] is None)
bad2 = bytearray(build_event(0x04, 0xA0, bytes([0, 80, 0, 75, 0, 60])))
bad2[19] ^= 0xFF  # checksum bozuk
k, i = parse(bytes(bad2))
check("bozuk checksum yakalandi", k == "sony" and not i["checksum_ok"])
check("bos rapor reddedildi", parse(bytes(64))[0] is None)

print("\n6) Checksum aralik kesfi")
kind, info = parse(frame)
check("buf[5..N] araligi eslesenler arasinda", 5 in info["checksum_matching_ranges"],
      str(info["checksum_matching_ranges"]))

print("\n" + "=" * 60)
if fails:
    print("BASARISIZ: %d test" % len(fails))
    for f in fails:
        print("  - %s" % f)
    sys.exit(1)
print("Tum testler gecti.")
