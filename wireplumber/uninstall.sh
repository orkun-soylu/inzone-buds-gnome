#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Undoes the Pro Audio pinning: removes the config rule and returns the saved
# profile to the dongle's stock behaviour (a single IEC958 sink).
set -e

CARD="alsa_card.usb-Sony_INZONE_Buds-00"
PROFILE="output:iec958-stereo+input:mono-fallback"
CONF="$HOME/.config/wireplumber/wireplumber.conf.d/51-inzone-pro-audio.conf"
STATE="$HOME/.local/state/wireplumber/default-profile"

rm -f "$CONF"
echo "removed: $CONF"

systemctl --user stop wireplumber
if [ -f "$STATE" ] && grep -q "^$CARD=" "$STATE"; then
    sed -i "s|^$CARD=.*|$CARD=$PROFILE|" "$STATE"
    echo "state restored: $CARD=$PROFILE"
fi
systemctl --user start wireplumber
