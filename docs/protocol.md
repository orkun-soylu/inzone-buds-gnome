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
| `0x22` | GAME_CHAT_MIX_BALANCE | `32` (=50) | **0..100**, `0` = oyun kısık — aşağıya bak |
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
<- RX->PC NOISE_CONTROL(0x41) NTFY tid=2  payload=00 14 ff 00     (kapalı)
-> PC->RX NOISE_CONTROL(0x41) GET  tid=3
<- RX->PC NOISE_CONTROL(0x41) RET  tid=3  payload=00 14 ff 00
```

**Faz 0 tamam:** okuma ve yazma doğrulandı, protokol engeli kalmadı.

### `0x41` NOISE_CONTROL — çözüldü

Payload: `[mod, ambient_seviye, 0xFF, 0x00]`

| mod | anlam | dayanak |
|---|---|---|
| `0` | kapalı | kullanıcı doğrulaması, cihaz üzerinde (2026-09-03) |
| `1` | ANC (gürültü engelleme) | kullanıcı doğrulaması, cihaz üzerinde (2026-09-03) |
| `2` | ambient (ortam sesi) | dinleme + kullanıcı doğrulaması — baştan doğruydu |

Sol kulaklığa tek dokunuş bu üçünü döndürüyor: `2 → 0 → 1 → …`
(ambient → kapalı → ANC → …)

`byte[1]` = ambient seviyesi, Sony aralığı **0–20**; ölçümde `0x14` = 20, yani
tavan. `byte[2]` = `0xFF` placeholder (H5'te de aynı desen), `byte[3]` = `0x00`.

⚠️ **Düzeltme (2026-09-03):** `0` ve `1` daha önce ters yazılmıştı. 2026-09-02
dinleme testi mod `0`'ı "dışarıdan ses gelmiyor" diye ANC sanmıştı — kulaklık
kapalı tip, pasif yalıtımı ANC'ye benziyor; mod `1` de "iki ucun arasında"
diye çıkarılmıştı. İkisi de yanlıştı, eşleme cihaz üzerinde doğrulandı.
**Ders:** mod etiketini kulakla ayırt etmeye çalışma, cihazın kendi arayüzünden
teyit et — pasif yalıtım ANC ile karışıyor.

**`0x06` extension için kritik:** batarya, ses ve balance'ı tek round-trip'te
veriyor. Quick Settings panelinin poll'u beş ayrı GET yerine bunu kullanmalı.

⚠️ **Push'lar sorgudan bağımsız gelir ve `tid=1` taşır.** Tarama sırasında araya
girip yanlış `event_id`'ye atfedilmeleri kolay — gelen çerçeve daima **kendi**
`event_id`'sine göre kaydedilmeli, sorulan ID'ye göre değil. (`query.py`'de bu
hata bir kez yapıldı ve düzeltildi.)

### `0x22` GAME_CHAT_MIX_BALANCE — yön ve tavan ölçüldü (2026-09-03)

Payload tek byte. Dongle bilgisayara iki ayrı USB ses akışı sunuyor (oyun +
sohbet); bu değer kulaklığın içindeki karışım oranı.

| değer | anlam | dayanak |
|---|---|---|
| `0` | oyun akışı tamamen kısık | dinleme testi: slider sol uçta Spotify tümüyle sustu |
| `100` | oyun akışı tam güçte | dinleme testi + `SET 0x64` kabul edildi, geri okundu |
| `50` | dinlenme değeri | ilk capture (`0x06` içinde de aynı) |

⚠️ **Önceki kayıt iki yönden birden yanlıştı** ("0..90, `0` = tam oyun"):

- **Tavan 90 değil 100.** `SET 0x22 = 0x64` → `NTFY` payload `64`, doğrulama
  GET'i de `64` döndü; cihaz kırpmadı. `90` H5 protokolünden taşınmış, bu
  cihazda hiç ölçülmemiş bir varsayımdı. Dinlenme değerinin `50` olması da
  0–100 ile tutarlı — 0–90'ın ortası `45` olurdu.
- **Yön ters.** `0` oyun tarafı değil, oyun tarafını **susturan** uç.

**Kanıt neden kesin:** ölçüm sırasında Spotify'ın akışı PipeWire'da
`INZONE Buds:playback_FL/FR`'a bağlıydı ve dongle'ın Linux'ta **tek** sink'i
var (`alsa_output.usb-Sony_INZONE_Buds-00.iec958-stereo`). Yani "acaba sohbet
cihazında mıydı" ihtimali yok; kısılan akış oyun akışı.

**Açık uç — ikinci PCM.** `aplay -l` kartta **iki** playback cihazı gösteriyor
(`card 2: Buds, device 0` ve `device 1`), ama WirePlumber'ın ACP profili tek
sink açıyor. PipeWire `device 0`'ı kullanıyor (`Subdevices: 0/1` = dolu),
`device 1` boşta. Sohbet akışı büyük ihtimalle o; hangisinin hangisi olduğu ve
profil değiştirilerek ikisinin birden açılıp açılamayacağı **ölçülmedi**.
Açılabilirse bu slider Linux'ta da gerçek bir denge kontrolü olur.

**Açık uç — kuantalama.** Ayarın 10'ar adım mı yoksa serbest mi olduğu
ölçülmedi; `0x64` (100) ve `0x28` (40) kabul edildi, ara bir değer (`0x37`)
denenmedi. Extension ihtiyattan 10'a yuvarlıyor (`extension.js`).

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

⚠️ **Dongle kendiliğinden yayın yapıyor — ama yalnızca durum DEĞİŞTİĞİNDE.**

İlk okuma (2026-09-02) "hiç yayın yapmıyor" idi: müzik çalarken 3 dakika pasif
dinlemede *sıfır* rapor geldi. **Düzeltme (2026-09-03):** o pencerede değişen bir
şey olmadığı içinmiş. Tarama sırasında sorulmadan şu geldi:

```
BATTERY_INFO(0x04)  NTFY_ACTIVE(0xA0)  tid=1  payload=00 55 00 54 ff 64
```

Batarya `86/85` → `85/84` düşmüştü. `NTFY_ACTIVE` + `tid=1`, yani push imzası.

Pratik sonuç: push yolu **gerçek**, extension'daki `pushed` sinyali ölü kod
değil. Ama olay seyrek ve öngörülemez — pasif dinlemeye dayanan bir tasarım
çalışmaz, poll şart. HeadsetControl'ün "the dongle sends unsolicited HID
reports" ifadesi doğru ama eksik: yolluyor, sadece nadiren.

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

## `0x8x` bloğu — yetenek/tanım tablosu

`--sweep 0x44-0xff` taramasında yalnızca `0x8x` aralığı cevap verdi:

| ID | payload | not |
|---|---|---|
| `0x81` | `0f` | |
| `0x83` | `00` | |
| `0x84` | `01` | |
| `0x85` | `00` | |
| `0x86` | `05 01 02 04 00 01 02 04` | iki grup, mod listesi olabilir |
| `0x87` | `00 00 01 00` | |
| `0x89` | `00 00 00 00 00 00` | **salt okunur** — SET'e cevap vermiyor, EQ değil |
| `0x8C` | 2×112 byte, **çok parçalı** | yetenek tablosu — **çözüldü**, aşağıya bak |
| `0x8D` | 2×12 byte | `0x8C`'nin aynı grameri, iki kayıtlık kısaltması |
| `0x8E` | `00` | |

### `0x8C` / `0x8D` çözüldü (2026-09-03, yakalamadan — donanımsız)

`tools/parse_caps.py` yakalamayı yeniden çözümlüyor. Gramerin doğruluk ölçütü
sert: dört parçanın **dördünde de artan 0 byte** kalıyor.

```
$ ./tools/parse_caps.py captures/sweep-hi.txt
```

⚠️ **Çok parçalı cevap:** aynı `tid` ile arka arkaya birden fazla çerçeve geliyor
(payload tavanı 50 byte). Tek çerçeve okuyup bırakan bir istemci veriyi yarım
alır. Parçalar `01 00 10` ile ayrılıyor — bu üç byte **framing**, tablo içeriği
değil. (`0x8D`'de de aynı ayraç var; oradaki 31 byte da eksik değil, tam.)

```
[0..3]   cevap başlığı  02 00 00 00
parça    <tür> <kayıtlar…>                parçalar arasında  01 00 10
BÖLÜM 1  <id> <count:LE16> <count × (slot, değer)>
ayraç    <kendi kimliği>
BÖLÜM 2  <00> <count>, ardından  <slot> <id> <len:LE16> <len-1 byte>
kapanış  BÖLÜM 1 grameriyle tek kayıt, id=0xFF, hepsi sıfır
```

`0x8C`'nin çözülmüş hâli (iki parça da aynı içerik):

| bölüm | içerik |
|---|---|
| BÖLÜM 1 | `id=00` → `00:01 01:00 02:00 07:70` · `id=10` → `00:23 01:00 02:00 07:24` · `id=70` → `00:71 01:00 02:00 07:72` · `id=20` → `00:20 01:21 02:22 07:00` |
| kendi kimliği | `71` (PC→RX cevabı) / `72` (PC→TX cevabı) |
| BÖLÜM 2 | slot `00`→id `23`, `01`→`24`, `02`→`01`, `07`→`70`; dördünün de listesi `01 20 21 22 23 24 70 71 72` (yalnız `07`'de sonda fazladan `10`) |
| kapanış | `id=ff`, dört slot da sıfır |

**Ana bulgu — `0x70`/`0x71`/`0x72` ayar değil, cihaz kimliği.** İki parça 112
byte'ın **yalnızca birinde** ayrışıyor (offset 45): kulaklığa sorulunca `0x71`,
dongle'a sorulunca `0x72`. Yani o byte "bu cevabı veren kim" alanı. `id=70`
kaydının slot `00`'ı `71`'i, slot `07`'si `72`'yi gösteriyor — kendi içinde
tutarlı. Bu, `0x70`–`0x72`'nin **düz GET'e neden cevap vermediğini açıklıyor**:
sorgulanacak event değiller, adresleme alanı.

⚠️ **`slot` uzayı {`00`, `01`, `02`, `07`} `event_id` uzayı DEĞİL.** Aynı sayılar
gerçek event_id olarak da var (`0x01` 2GHZ_CONNECT_STATUS, `0x02` DEVICE_INFO…);
ikisini karıştırma. Slotlar her iki bölümde de ortak.

⚠️ **Liste "desteklenen tüm event'ler" değil.** `01 20 21 22 23 24 70 71 72`
içinde çalıştığı ölçülmüş `0x04` (batarya), `0x06` (toplu durum) ve `0x41`
(gürültü kontrolü) **yok**. Tablo yalnızca ses ayarları öbeğini kapsıyor —
**EQ/spatial buradan çıkmıyor**, oraya başka yoldan bakılmalı.

### `0x89` — denendi, **EQ değil** (2026-09-03, laptop)

Hipotez şuydu: altı sıfır byte, BudsLink'te `equalizerSixBands` bayrağı var,
INZONE Hub'da EQ var → `0x89` altı bantlı EQ olabilir. **Yanlış çıktı.**

| deneme | sonuç |
|---|---|
| `GET 0x89 -a rx` | `RET`, `00 00 00 00 00 00` |
| `SET 0x89 -a rx` payload `00×6` | **cevap yok** (iki kez) |
| `GET 0x89 -a tx` | cevap yok (dört checksum varyantı da) |
| `SET 0x89 -a tx` payload `00×6` | cevap yok |
| **kontrol:** `SET 0x41 -a rx` payload `02 12 ff 00` | `NTFY(0x20)` + doğrulama GET ✓ |

Son satır belirleyici: **aynı oturumda, aynı node ve adreste, aynı checksum
kuralıyla** bilinen bir event SET'i kabul etti. Yani `0x89`'ın sessizliği
bağlantıdan değil kendisinden geliyor — okunabilir ama yazılamaz.

Gönderilen çerçeve de doğrulandı, kurgu hatası değil:
`02 12 01 00 fc 0e 96 c3 41 89 02 02 00 · 00×6 · 27` — `hid_length`=12+6,
`param_length`=8+6, checksum `buf[6..18]` toplamı = 0x27. ✓

⚠️ **Denenmeyen tek varyant: farklı payload uzunluğu.** Yalnız 6 bayt denendi
(okunan uzunluk). `0x89` başka bir uzunluk bekliyor olabilir. Ama `0x8C` yetenek
tablosu EQ'yu zaten içermiyor, dolayısıyla bu protokolde EQ'nun varlığına dair
elimizde hiçbir olumlu kanıt kalmadı.

**Sonuç: `0x8x` bloğunda EQ adayı kalmadı.** EQ/spatial bu vendor HCI kanalında
görünmüyor; Sony bunları başka bir mekanizmayla (ayrı bir arayüz ya da yalnız
INZONE Hub'ın kullandığı bir uç) yürütüyor olmalı.

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
