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

## Saha bulguları (2026-09-02, laptop)

`054c:0ec2` takılı, `/dev/hidraw6`, report descriptor **158 byte** ve içinde
`06 04 ff` var — yani **`0xFF04` vendor collection mevcut.** Kontrol kanalı
fiziksel olarak orada.

⚠️ **Dongle kendiliğinden yayın yapmıyor.** Müzik çalarken 3 dakika pasif
dinlemede *sıfır* rapor geldi. HeadsetControl'ün buds sürücüsündeki "the dongle
sends unsolicited HID reports" ifadesi genel durum için yanlış; o raporlar
muhtemelen yalnızca belirli olaylarda (bağlanma, kutuya koyma) çıkıyor.

Sonuç: veri almak için **önce host'un GET yollaması gerekiyor** — tıpkı H5
sürücüsünün `exchange()` deseni gibi. `tools/query.py` bunu yapıyor.

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
