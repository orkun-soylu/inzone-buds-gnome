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

**Checksum — tek kural: `sum(buf[6..N]) & 0xFF`, konum `buf[N+1]`.**

H5 sürücüsü okuma tarafında `sum(buf[5..N])` yazıyor ve bu da çalışıyor, ama
sadece EVENT çerçevelerinde `buf[5]` sıfır dummy olduğu için. COMMAND
çerçevelerinde `buf[5]` = `param_length` (sıfır değil) ve oradan başlamak
**yanlış** sonuç verir. Ölçüldü (2026-09-02), gönderilen gerçek SET:

```
02 10 01 00 fc 0c 96 c3 41 41 02 02 00 | 00 14 ff 00 | f2
                └── buf[6] ───────────────────────┘    checksum
```

`sum(buf[6..16]) = 0xF2` ✓ · `sum(buf[5..16]) = 0xFE` ✗ (kabul edilmezdi).

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

## event_id haritası

`--sweep 0x00-0x43` taramasından (2026-09-02, PC→RX ve PC→TX). `?` = tahmin.

| ID | İsim | Gözlenen payload | Yorum |
|---|---|---|---|
| `0x01` | 2GHZ_CONNECT_STATUS | `01 01` (TX) | dongle cevaplıyor, kulaklık değil |
| `0x02` | DEVICE_INFO? | `04 02 ff ff ff 00` + `"1020113"`×3 + `01 01` | ASCII firmware sürümü, sol/sağ/kutu |
| `0x03` | CAPABILITY? | `03 00 40 00` × 3 | cihaz başına sabit üçlü |
| `0x04` | BATTERY_INFO | `00 63 00 62 ff 64` | `[durum, %] × (sağ, sol, kutu)` |
| `0x05` | DONGLE_STATE? | `00` (TX) | |
| `0x06` | **STATUS_BULK?** | `04 · 00 63 00 62 ff 64 · 00 1c ff · 32 · 00 ff` | **batarya + ses + balance tek cevapta** |
| `0x07` | STATUS_BULK2? | `00 ff ff 01 14 ff 00 01 01 01` | içinde `0x41` payload'ı (`01 14 ff 00`) |
| `0x08` | — | `03 ff ff ff ff 0f ff 00 01 00` | |
| `0x09` | — | `00` (RX ve TX) | |
| `0x21` | HEADPHONE_VOLUME | `00 1c ff` | **byte[1] = ses**; tuşla `1c→1d→1e` ilerledi |
| `0x22` | GAME_CHAT_MIX_BALANCE | `32` (=50) | 0..90, 10'ar adım |
| `0x23` | SIDETONE_VOLUME | `00 ff` | |
| `0x24` | MIC_VOLUME | `00 ff ff` | |
| `0x41` | **NOISE_CONTROL** | `01 14 ff 00` | `[mod, ambient_seviye, ff, 00]` — aşağıya bak |
| `0x42` | — | `01 01 01` | |
| `0x43` | — | `03` | |

### Dokunmatik kontroller (Sony varsayılanı)

Fiziksel düğme yok. Dongle üzerinden geçerli olan varsayılan atamalar:

| Hareket | Sol | Sağ |
|---|---|---|
| Tek dokunuş | gürültü engelleme ↔ ambient geçişi → `0x41` | ses yükselt → `0x21` |
| Dokun ve tut | mikrofon kontrolü | ses azalt |
| Çift / üç dokunuş | dongle'da işlevsiz | dongle'da işlevsiz |

Atamalar INZONE Hub / Sony Sound Connect ile değiştirilebiliyor, yani bir
`event_id`'nin arkasında bu eşleme de olmalı (henüz bulunmadı).

### Yazma doğrulandı (2026-09-02)

`SET` → cihaz `NTFY(0x20)` ile aynı TID'i geri döndürüyor, ardından doğrulama
`GET` yeni durumu okuyor. İki yönde de çalıştı:

```
-> PC->RX NOISE_CONTROL(0x41) SET  tid=2  payload=00 14 ff 00
<- RX->PC NOISE_CONTROL(0x41) NTFY tid=2  payload=00 14 ff 00     (ANC)
-> PC->RX NOISE_CONTROL(0x41) GET  tid=3
<- RX->PC NOISE_CONTROL(0x41) RET  tid=3  payload=00 14 ff 00
```

**Faz 0 tamam:** okuma ve yazma doğrulandı, protokol engeli kalmadı.

### `0x41` NOISE_CONTROL — çözüldü

Payload: `[mod, ambient_seviye, 0xFF, 0x00]`

| mod | anlam | dayanak |
|---|---|---|
| `0` | ANC (gürültü engelleme) | dinleme: dışarıdan ses gelmiyor |
| `1` | kapalı | **çıkarım** — 0 ile 2 arasında kaldığı için |
| `2` | ambient (ortam sesi) | dinleme: en çok dış ses |

Sol kulaklığa tek dokunuş bu üçünü döndürüyor: `2 → 0 → 1 → …`

`byte[1]` = ambient seviyesi, Sony aralığı **0–20**; ölçümde `0x14` = 20, yani
tavan. `byte[2]` = `0xFF` placeholder (H5'te de aynı desen), `byte[3]` = `0x00`.

⚠️ mod `1`'in "kapalı" olduğu doğrudan doğrulanmadı, iki uçtan çıkarıldı.

**`0x06` extension için kritik:** batarya, ses ve balance'ı tek round-trip'te
veriyor. Quick Settings panelinin poll'u beş ayrı GET yerine bunu kullanmalı.

⚠️ **Push'lar sorgudan bağımsız gelir ve `tid=1` taşır.** Tarama sırasında araya
girip yanlış `event_id`'ye atfedilmeleri kolay — gelen çerçeve daima **kendi**
`event_id`'sine göre kaydedilmeli, sorulan ID'ye göre değil. (`query.py`'de bu
hata bir kez yapıldı ve düzeltildi.)

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

## `0x8x` bloğu — yetenek/tanım tablosu (açık uç)

`--sweep 0x44-0xff` taramasında yalnızca `0x8x` aralığı cevap verdi:

| ID | payload | not |
|---|---|---|
| `0x81` | `0f` | |
| `0x83` | `00` | |
| `0x84` | `01` | |
| `0x85` | `00` | |
| `0x86` | `05 01 02 04 00 01 02 04` | iki grup, mod listesi olabilir |
| `0x87` | `00 00 01 00` | |
| `0x89` | `00 00 00 00 00 00` | **EQ adayı** — 6 byte / 6 bant |
| `0x8C` | ~115 byte, **çok parçalı** | yetenek tablosu, aşağıya bak |
| `0x8D` | 31 byte, `0x8C`'ye benzer yapı | |
| `0x8E` | `00` | |

⚠️ **`0x8C` çok parçalı cevap veriyor:** aynı `tid` ile arka arkaya birden fazla
çerçeve geliyor (payload tavanı 50 byte, blob daha uzun). Tek çerçeve okuyup
bırakan bir istemci veriyi yarım alır.

Birleştirilmiş blobda tekrar eden `01 20 21 22 23 24 70 71 72` listeleri var —
bunlar **event_id listeleri**, yani `0x8C` "hangi event'ler destekleniyor"
tablosu. İçinde `0x70`, `0x71`, `0x72` geçiyor ama **bu üçü düz GET'e cevap
vermedi** — başka bir erişim biçimleri olmalı (payload'lu GET, ya da yalnızca
SET). `0x20` için de aynı durum.

**`0x89` en umut verici açık uç.** Altı sıfır byte; BudsLink Sony modellerinde
`equalizerSixBands` bayrağı taşıyor ve INZONE Hub'da EQ var. Doğrulanmadı —
denemek için `0x89`'a SET atıp sesi dinlemek, sonra `00 00 00 00 00 00` ile geri
almak gerekir. Değer aralığı bilinmiyor (Sony genelde 0–20, 10 = düz kullanır;
altı sıfırın "düz" mü "ayarsız" mı olduğu belirsiz).

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
