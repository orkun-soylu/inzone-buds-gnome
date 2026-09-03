#!/bin/sh
# INZONE Buds dongle'ini Pro Audio profiline sabitler. 'make wireplumber' bunu cagirir.
#
# IKI katman birden gerekiyor (olculdu 2026-09-03):
#   1. config kurali  -> temiz makinede, kayitli durum yokken profili secer
#   2. kayitli durum  -> WirePlumber'in default-profile state'i config'i EZIYOR.
#      Yalnizca config konuldugunda cihaz iec958'de kaldi; state duzeltilince
#      dongle cikarilip takildiktan sonra bile pro-audio'da kaliyor.
#
# 'wpctl set-profile' tek basina KALICI DEGIL: profili o an degistiriyor ama
# state dosyasina yazmiyor, replug'da eski profil geri geliyor.
set -e

CARD="alsa_card.usb-Sony_INZONE_Buds-00"
PROFILE="pro-audio"
SRC="$(dirname "$0")/51-inzone-pro-audio.conf"
CONF_DIR="$HOME/.config/wireplumber/wireplumber.conf.d"
CONF="$CONF_DIR/51-inzone-pro-audio.conf"
STATE="$HOME/.local/state/wireplumber/default-profile"

mkdir -p "$CONF_DIR"
cp -f "$SRC" "$CONF"
echo "kuruldu: $CONF"

# Servis calisirken state duzenlenirse WirePlumber cikarken dosyayi geri yazar
# ve degisiklik kaybolur. Once durdur.
systemctl --user stop wireplumber

mkdir -p "$(dirname "$STATE")"
if [ ! -f "$STATE" ]; then
    printf '[default-profile]\n%s=%s\n' "$CARD" "$PROFILE" > "$STATE"
elif grep -q "^$CARD=" "$STATE"; then
    sed -i "s|^$CARD=.*|$CARD=$PROFILE|" "$STATE"
else
    printf '%s=%s\n' "$CARD" "$PROFILE" >> "$STATE"
fi
echo "state guncellendi: $STATE  ($CARD=$PROFILE)"

systemctl --user start wireplumber
sleep 2

echo
echo "Dogrulama:"
wpctl status | grep -i 'inzone buds pro' || {
    echo "  UYARI: pro-audio sink'leri gorunmedi." >&2
    echo "  Bak: journalctl --user -u wireplumber -n 30 --no-pager" >&2
    exit 1
}
echo
echo "pro-output-0 = oyun akisi, pro-output-1 = sohbet akisi."
echo "Sesli gorusme uygulamasini 'INZONE Buds Pro 1'e yonlendir; gerisi varsayilanda kalsin."
