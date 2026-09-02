# Sony INZONE dongle protokolü — bilinenler

Kaynak: `Sapd/HeadsetControl`, `lib/devices/sony_inzone_h5.hpp` (tam protokol) ve
`lib/devices/sony_inzone_buds.hpp` (naif dinleyici).

## Taşıma

USB dongle, HID. Kontrol kanalı **vendor collection usage page `0xFF04`, usage `0x0002`**.
Report ID `0x02`, 64 byte. Feature report / ioctl yok — düz interrupt in/out,
yani `/dev/hidrawN` üzerinde `read()`/`write()` yeterli.

| Cihaz | VID:PID |
|---|---|
| INZONE Buds (WF-G700N) | `054c:0ec2` |
| INZONE H5 (WH-G500) | `054c:0ebf` |

## Çerçeve

Sony vendor katmanı, Bluetooth HCI'nin üstüne ince bir sarmalayıcı olarak oturuyor.
Host `0xFC00` opcode'lu COMMAND yolluyor, dongle `0xFF` vendor event code'uyla cevaplıyor.

```
[0]      report id   = 0x02
[1]      hid_length  = 12 + len(payload)
[2]      hci_type    = 0x01 COMMAND (host->cihaz) | 0x04 EVENT (cihaz->host)
[3]      COMMAND: opcode lo = 0x00   |  EVENT: event code = 0xFF
[4]      COMMAND: opcode hi = 0xFC   |  EVENT: param_length
[5]      COMMAND: param_length       |  EVENT: dummy = 0x00
[6..7]   sony key = 96 C3   (0xC396 LE)
[8]      address = (dst<<4) | src      1=PC  2=TX(dongle)  4=RX(kulaklık)
[9]      event_id
[10]     event_type
[11..12] transaction id (LE)
[13..]   payload
[N+1]    checksum        N = hid_length
```

⚠️ COMMAND ve EVENT yönünde `[3..5]` farklı anlam taşıyor — HeadsetControl'ün
`buildCommand` ve `parseEvent` fonksiyonları bu yüzden simetrik değil.

**Checksum.** H5'te `sum(buf[5..N]) & 0xFF`. Yazarken `sum(buf[6..N])`
(post-report-id offsetleriyle `HCI[4..end-1]`) olarak hesaplanıyor — okuma ve
yazma tarafı bir byte kayık, bu upstream'de böyle. `sniff.py` hangi aralığın
gerçekten tuttuğunu ölçüyor, varsayım yapmıyor.

## event_type

| Değer | Anlam |
|---|---|
| `0x01` | GET |
| `0x02` | SET |
| `0x10` | RET — GET'in cevabı |
| `0x20` | NTFY — SET'in cevabı |
| `0xA0` | NTFY_ACTIVE — cihazın kendiliğinden gönderdiği (TID=1) |

GET/SET yollarken TID eşleştirilmeli. **TID 0 ve 1 kullanılmaz** — dongle'ın kendi
push'ları TID=1 taşıyor, yeniden kullanılırsa push cevap sanılır.

## event_id — H5'ten bilinenler

| ID | İsim | Payload |
|---|---|---|
| `0x01` | 2GHZ_CONNECT_STATUS | — |
| `0x04` | BATTERY_INFO | H5: `[şarj, yüzde]` · Buds: `[şarj, yüzde] × (sağ, sol, kutu)` |
| `0x21` | HEADPHONE_VOLUME | 0..50 |
| `0x22` | GAME_CHAT_MIX_BALANCE | 0..90, 10'ar adım (0=full game) |
| `0x23` | SIDETONE_VOLUME | `[seviye, 0xFF]` — aralık doğrulanmamış |
| `0x24` | MIC_VOLUME | `[mute, seviye, 0xFF]` — aralık doğrulanmamış |

## Saha bulguları (2026-09-02, laptop) — PROTOKOL DOĞRULANDI

Dongle `054c:0ec2` → `/dev/hidraw6`, report descriptor 158 byte.

**Doğrulanan alışveriş:**

```
-> PC->RX  BATTERY_INFO(0x04)  GET  tid=2
<- RX->PC  BATTERY_INFO(0x04)  RET  tid=2  payload=00 63 00 63 ff 64
```

Buds, H5 ile **aynı** Sony vendor HCI protokolünü konuşuyor. Doğrulananlar:
çerçeve düzeni, `0xC396` key, adres nibble'ları, GET→RET semantiği, TID
eşleşmesi ve checksum.

**Checksum, yazma yönü: `sum(buf[6..12+len(payload)]) & 0xFF`** (yani
`--cksum-lo 6`, H5'in `buildCommand`'ıyla aynı). İlk denemede tuttu.

⚠️ **Dongle kendiliğinden yayın yapmıyor.** Müzik çalarken 3 dakika pasif
dinlemede *sıfır* rapor geldi. HeadsetControl'ün buds sürücüsündeki "the dongle
sends unsolicited HID reports" ifadesi genel durum için yanlış — o sürücü
çalışıyorsa bile ancak cihaz kendiliğinden bir şey yolladığında çalışır.
Doğru yol GET sormak.

### Batarya payload'ı (6 byte, ölçüldü)

`[durum, yüzde] × (sağ, sol, kutu)`. Her iki alanda da **`0xFF` = bilinmiyor**.

Yakalanan `00 63 00 63 ff 64` → sağ 99%, sol 99%, kutu 100% ama kutunun *durum*
byte'ı `0xFF`: kulaklıklar takılıyken kutu dongle'a bağlı değil, o yüzden şarj
durumu bilinmiyor. `0xFF`'i "şarj oluyor" diye okumak hatadır.

### HID report descriptor — beş collection

| usage_page | usage | report | yön / boyut | yorum |
|---|---|---|---|---|
| `0xFF04` | `0x0001` | `0x02` | In 63B, Out 63B | **kontrol kanalı** (doğrulandı) |
| `0xFF13` | `0x0001` | `0x06` / `0x07` | Out 61B / In 61B | ikinci çift yönlü vendor kanalı, bilinmiyor |
| `0x000C` | `0x0001` | `0x0C` | In 1B | Consumer — dokunmatik medya tuşları |
| `0xFF03` | `0x0020` | `0xA0` / `0xA1` | Feat 34B / 22B | feature report, muhtemelen cihaz kimliği |
| `0xFF01` | `0x0020` | `0xB0` | In 7B | 7 usage (`0x25`–`0x2B`), durum/buton olabilir |

Ham descriptor:

```
0613ff0901a101150026ff00850609007508953d9102850709007508953d8102c0
050c0901a101850c1500250109e909ea09e209cd09b509b6750195068102090095028102c0
0604ff0901a101150026ff0085027508953f0902810209039102c0
0603ff0920a101092185a0150026ff0075089522b102092285a19516b102c0
0601ff0920a10185b009250926092709280929092a092b750895078102c0
```

⚠️ H5 sürücüsü `0xFF04` için usage `0x0002` diyor, buds'ta usage `0x0001`.
Vendor collection'ı usage'a göre değil, **usage_page'e göre** seç.

## Buds'ın aynı protokolü konuştuğu tezi

HeadsetControl'ün buds sürücüsü protokolü bilmiyor: hiç komut yollamıyor, sadece
`byte[1]==0x12 && byte[2]==0x04` desenini bekliyor ve bunlara "BATTERY_TYPE /
BATTERY_SUBTYPE" diyor. H5 çerçevesinde bu ikisi **`hid_length`=18 ve
`HCI_TYPE_EVENT`**. `tools/selftest.py`, H5 spesifikasyonundan kurulan bir batarya
çerçevesinin buds sürücüsündeki *bütün* sabitleri (offset 14/16/18, checksum@19)
ürettiğini gösteriyor.

Buds sürücüsünün header'ındaki `(byte[14]+byte[16]+117) mod 256` checksum formülü
kutu byte'ını hesaba katmıyor — yani gözlemden aşırı uydurulmuş, protokolü bilerek
yazılmamış. Bu da tezi güçlendiriyor.

**Doğrulanmamış:** buds'ın SET kabul edip etmediği ve ANC / EQ / spatial / tap
ayarlarının event_id'leri. Sony'nin kendi dokümanı EQ, Spatial Sound, DRC,
game/chat balance ve mikrofon seviyesinin "yalnızca USB transceiver ile bağlıyken"
çalıştığını söylüyor — yani bu ayarlar bu kanalda olmak zorunda.

## Bluetooth yolu neden yok

INZONE Buds **sadece LE Audio** (BT 5.3; TMAP/CSIP/MCP/VCP/CCP; LC3). Bluetooth
Classic yok → A2DP/HFP yok → **RFCOMM yok**. Sony'nin klasik kulaklıklarındaki SPP
protokolü (`96cc203e-…` v1 / `956c7b26-…` v2, `maniacx/BudsLink` ve arşivlenmiş
`Plutoberth/SonyHeadphonesClient` bunu kullanıyor) bu cihazda **açılamaz**.
BudsLink'e 27 satırlık bir device config eklemek işe yaramaz.
