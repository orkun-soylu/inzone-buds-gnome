#!/usr/bin/env bash
# Faz 0 — INZONE Buds dongle keşfi. Salt okuma, cihaza hiçbir şey yazmaz.
# Kullanım:  sudo ./tools/probe.sh
set -uo pipefail

VID=054c
PID=0ec2

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "USB"
if command -v lsusb >/dev/null; then
    lsusb | grep -i "$VID:" || echo "  ! $VID:$PID bulunamadı — dongle takılı mı?"
else
    echo "  (lsusb yok, atlanıyor)"
fi

say "Ses cihazları (dongle iki ayrı çıkış sunar: Game / Chat)"
if command -v pactl >/dev/null; then
    pactl list short sinks   2>/dev/null | grep -i -E 'inzone|sony|g700' || echo "  (eşleşen sink yok)"
    pactl list short sources 2>/dev/null | grep -i -E 'inzone|sony|g700' || echo "  (eşleşen source yok)"
else
    echo "  (pactl yok, atlanıyor)"
fi

say "hidraw node'ları"
found=0
for d in /sys/class/hidraw/hidraw*; do
    [ -e "$d" ] || continue
    node=/dev/$(basename "$d")
    uevent=$d/device/uevent
    [ -r "$uevent" ] || continue
    hid_id=$(grep -m1 '^HID_ID=' "$uevent" | cut -d= -f2)
    hid_name=$(grep -m1 '^HID_NAME=' "$uevent" | cut -d= -f2-)
    # HID_ID biçimi: BUS:0000VVVV:0000PPPP  (hex, büyük harf)
    case "${hid_id^^}" in
        *:0000054C:00000EC2)
            found=1
            desc=$d/device/report_descriptor
            hex=$(xxd -p "$desc" 2>/dev/null | tr -d '\n')
            size=$(( ${#hex} / 2 ))
            # Usage Page (16-bit) 0xFF04  ->  06 04 ff
            if [[ "$hex" == *"0604ff"* ]]; then
                mark=$'\033[32mVENDOR 0xFF04  <-- KONTROL KANALI\033[0m'
            else
                # hangi vendor sayfaları var?
                pages=$(echo "$hex" | grep -o '06..ff' | sort -u | tr '\n' ' ')
                mark="(0xFF04 yok${pages:+; vendor sayfalari: $pages})"
            fi
            printf '  %-16s perm=%s  desc=%sB  %s\n' \
                "$node" "$(stat -c '%A %U:%G' "$node" 2>/dev/null || echo '?')" "$size" "$mark"
            printf '      name: %s\n' "$hid_name"
            printf '      descriptor: %s\n' "$hex"
            ;;
    esac
done
[ "$found" = 1 ] || echo "  ! $VID:$PID için hidraw node yok — dongle takılı değil ya da kernel bağlamamış"

say "Sonraki adım"
echo "  sudo ./tools/sniff.py          # 0xFF04 node'unu otomatik seçip pasif dinler"
