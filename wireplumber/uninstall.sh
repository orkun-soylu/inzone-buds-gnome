#!/bin/sh
# Pro Audio sabitlemesini geri alir: config kurali silinir, kayitli profil
# dongle'in fabrika davranisina (tek sink, IEC958) dondurulur.
set -e

CARD="alsa_card.usb-Sony_INZONE_Buds-00"
PROFILE="output:iec958-stereo+input:mono-fallback"
CONF="$HOME/.config/wireplumber/wireplumber.conf.d/51-inzone-pro-audio.conf"
STATE="$HOME/.local/state/wireplumber/default-profile"

rm -f "$CONF"
echo "kaldirildi: $CONF"

systemctl --user stop wireplumber
if [ -f "$STATE" ] && grep -q "^$CARD=" "$STATE"; then
    sed -i "s|^$CARD=.*|$CARD=$PROFILE|" "$STATE"
    echo "state geri alindi: $CARD=$PROFILE"
fi
systemctl --user start wireplumber
