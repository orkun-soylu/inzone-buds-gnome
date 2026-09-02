# inzone-buds-gnome

Sony INZONE Buds (WF-G700N) için Linux/GNOME kontrol paneli — **Faz 0: protokol doğrulama.**

Bu kulaklık sadece LE Audio konuşuyor (Bluetooth Classic yok), bu yüzden mevcut
Linux Sony araçları (BudsLink, SonyHeadphonesClient — ikisi de RFCOMM SPP) çalışmıyor.
Tek kontrol kanalı USB-C dongle, HID üzerinden.

## Laptop'ta çalıştır

Dongle takılıyken:

```bash
sudo ./tools/probe.sh          # dongle + hidraw + vendor collection keşfi
sudo ./tools/sniff.py -s 120   # 2 dk pasif dinle
```

`sniff.py` **cihaza hiçbir şey yazmaz** — müzik dinlerken çalıştırmak güvenli.

Dinlerken kulaklıkta bir şeyler değiştir: ANC/ambient modunu çevir, ses seviyesini
oynat, bir kulaklığı kutuya koy. Hangi `event_id`'nin değiştiği böylece ortaya çıkar.

Çıktının sonundaki **ÖZET** tablosu asıl sonuç: `H5'te yok` işaretli satırlar
keşfedilen yeni event'ler.

## Donanımsız test

```bash
./tools/selftest.py
```

## Ne bulunduğuna dair

`docs/protocol.md` — çerçeve düzeni, bilinen `event_id`'ler ve bu kulaklığın
INZONE H5 ile aynı protokolü konuştuğu tezinin dayanağı.
