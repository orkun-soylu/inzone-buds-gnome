#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Pins the INZONE Buds dongle to the Pro Audio profile. Called by 'make wireplumber'.
#
# BOTH layers are needed (measured):
#   1. config rule  -> picks the profile on a clean machine with no saved state
#   2. saved state  -> WirePlumber's default-profile state OVERRIDES the config.
#      With only the config in place the device stayed on iec958; once the state
#      was fixed it stayed on pro-audio even after unplugging and replugging.
#
# 'wpctl set-profile' alone is NOT persistent: it changes the profile right away
# but never writes the state file, so the old profile returns on replug.
set -e

CARD="alsa_card.usb-Sony_INZONE_Buds-00"
PROFILE="pro-audio"
SRC="$(dirname "$0")/51-inzone-pro-audio.conf"
CONF_DIR="$HOME/.config/wireplumber/wireplumber.conf.d"
CONF="$CONF_DIR/51-inzone-pro-audio.conf"
STATE="$HOME/.local/state/wireplumber/default-profile"

mkdir -p "$CONF_DIR"
cp -f "$SRC" "$CONF"
echo "installed: $CONF"

# If the state is edited while the service runs, WirePlumber writes the file
# back on exit and the change is lost. Stop it first.
systemctl --user stop wireplumber

mkdir -p "$(dirname "$STATE")"
if [ ! -f "$STATE" ]; then
    printf '[default-profile]\n%s=%s\n' "$CARD" "$PROFILE" > "$STATE"
elif grep -q "^$CARD=" "$STATE"; then
    sed -i "s|^$CARD=.*|$CARD=$PROFILE|" "$STATE"
else
    printf '%s=%s\n' "$CARD" "$PROFILE" >> "$STATE"
fi
echo "state updated: $STATE  ($CARD=$PROFILE)"

systemctl --user start wireplumber
sleep 2

echo
echo "Check:"
wpctl status | grep -i 'inzone buds pro' || {
    echo "  WARNING: the pro-audio sinks did not show up." >&2
    echo "  See: journalctl --user -u wireplumber -n 30 --no-pager" >&2
    exit 1
}
echo
echo "pro-output-0 = game stream, pro-output-1 = chat stream."
echo "Route your voice-chat app to 'INZONE Buds Pro 1'; leave everything else on the default."
