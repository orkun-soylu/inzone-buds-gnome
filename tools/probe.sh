#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# INZONE Buds dongle discovery. Read only, writes nothing to the device.
# Usage:  sudo ./tools/probe.sh
set -uo pipefail

VID=054c
PID=0ec2

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "USB"
if command -v lsusb >/dev/null; then
    lsusb | grep -i "$VID:" || echo "  ! $VID:$PID not found — is the dongle plugged in?"
else
    echo "  (no lsusb, skipping)"
fi

say "Audio devices (the dongle offers two outputs: Game / Chat)"
if command -v pactl >/dev/null; then
    pactl list short sinks   2>/dev/null | grep -i -E 'inzone|sony|g700' || echo "  (no matching sink)"
    pactl list short sources 2>/dev/null | grep -i -E 'inzone|sony|g700' || echo "  (no matching source)"
else
    echo "  (no pactl, skipping)"
fi

say "hidraw nodes"
found=0
for d in /sys/class/hidraw/hidraw*; do
    [ -e "$d" ] || continue
    node=/dev/$(basename "$d")
    uevent=$d/device/uevent
    [ -r "$uevent" ] || continue
    hid_id=$(grep -m1 '^HID_ID=' "$uevent" | cut -d= -f2)
    hid_name=$(grep -m1 '^HID_NAME=' "$uevent" | cut -d= -f2-)
    # HID_ID format: BUS:0000VVVV:0000PPPP  (hex, upper case)
    case "${hid_id^^}" in
        *:0000054C:00000EC2)
            found=1
            desc=$d/device/report_descriptor
            # xxd is not on every system (it comes with vim-common). Do NOT swallow
            # the error — an empty hex looks like "no 0xFF04" and misleads.
            if command -v xxd >/dev/null; then
                hex=$(xxd -p "$desc" | tr -d '\n')
            elif command -v od >/dev/null; then
                hex=$(od -An -v -tx1 "$desc" | tr -d ' \n')
            else
                hex=$(python3 -c 'import sys;print(open(sys.argv[1],"rb").read().hex())' "$desc")
            fi
            size=$(( ${#hex} / 2 ))
            if [ "$size" = 0 ]; then
                echo "  ! $node: cannot read report_descriptor (are you root?)"
                continue
            fi
            # Usage Page (16-bit) 0xFF04  ->  06 04 ff
            if [[ "$hex" == *"0604ff"* ]]; then
                mark=$'\033[32mVENDOR 0xFF04  <-- CONTROL CHANNEL\033[0m'
            else
                # which vendor pages are there?
                pages=$(echo "$hex" | grep -o '06..ff' | sort -u | tr '\n' ' ')
                mark="(no 0xFF04${pages:+; vendor pages: $pages})"
            fi
            printf '  %-16s perm=%s  desc=%sB  %s\n' \
                "$node" "$(stat -c '%A %U:%G' "$node" 2>/dev/null || echo '?')" "$size" "$mark"
            printf '      name: %s\n' "$hid_name"
            printf '      descriptor: %s\n' "$hex"
            ;;
    esac
done
[ "$found" = 1 ] || echo "  ! no hidraw node for $VID:$PID — the dongle is not plugged in or the kernel did not bind it"

say "Descriptor decode"
if [ "$found" = 1 ] && command -v python3 >/dev/null; then
    python3 "$(dirname "$0")/parse_desc.py" 2>&1 || echo "  (parse_desc.py failed)"
fi

say "Next step"
echo "  sudo ./tools/query.py          # sends a GET and waits for the reply"
