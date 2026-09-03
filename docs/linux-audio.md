# Linux ses tarafı — oyun/sohbet ayrımı

Bu dosya protokolü değil, **kulaklığın Linux'ta düzgün çalışması için gereken
ses yapılandırmasını** anlatır. Protokol için → `protocol.md`.

## Sorun

Dongle bilgisayara **iki playback PCM'i** sunuyor:

```
card 2: Buds [INZONE Buds], device 0: USB Audio        → oyun akışı
card 2: Buds [INZONE Buds], device 1: USB Audio #1     → sohbet akışı
```

Kulaklık bu ikisini kendi içinde karıştırıyor ve karışım oranı vendor HCI
üzerinden ayarlanabiliyor (`0x22 GAME_CHAT_MIX_BALANCE`, bkz. `protocol.md`).
Windows'ta INZONE Hub'ın "Game/Chat Balance" kaydırıcısı budur.

**Ama ALSA'nın varsayılan ACP profillerinin hiçbiri iki PCM'i birden açmıyor.**
`pw-cli e <devid> EnumProfile` çıktısındaki yedi profilden altısı tek sink
veriyor; varsayılan seçilen `output:iec958-stereo+input:mono-fallback`.

Sonuç: sohbet akışına hiçbir uygulama yönlendirilemiyor, dolayısıyla denge
ayarı iki akış arasında denge kurmuyor — tek akışı kısıyor. Kaydırıcıyı sola
çekmek sadece sesi azaltıyor.

## Çözüm: `pro-audio` profili

Yedinci profil (`pro-audio`, index 5) `Audio/Sink` altında **iki** cihaz
listeliyor. Seçildiğinde:

| PipeWire node | ALSA | akış |
|---|---|---|
| `alsa_output.usb-Sony_INZONE_Buds-00.pro-output-0` | `hw:2,0` | **oyun** |
| `alsa_output.usb-Sony_INZONE_Buds-00.pro-output-1` | `hw:2,1` | **sohbet** |
| `alsa_input.usb-Sony_INZONE_Buds-00.pro-input-0` | — | mikrofon |

Eşleme `wpctl inspect <sink-id>` çıktısındaki `api.alsa.path` alanından
okundu — tahmin değil. Hangi PCM'in hangi akış olduğu ayrıca dinlenerek
doğrulandı (`speaker-test -D plughw:2,1` balance `0`'da tam güçlü, `100`'de
kısık; Spotify `hw:2,0`'da tam tersi).

### Kurulum

```bash
make wireplumber
```

`wireplumber/51-inzone-pro-audio.conf` dosyasını
`~/.config/wireplumber/wireplumber.conf.d/` altına kopyalar ve WirePlumber'ı
yeniden başlatır. Doğrulama:

```bash
wpctl status | grep -i inzone     # IKI sink gorunmeli
```

### Neden iki katman

Kalıcı hale getirmek beklenenden zor çıktı; üç ayrı şey denendi:

| yöntem | sonuç |
|---|---|
| `wpctl set-profile <dev> 5` | o an çalışıyor, **replug'da kayboluyor** — state dosyasına hiç yazmıyor |
| `wpctl set-default <sink>` | varsayılanı taşıyor ama profili sabitlemiyor |
| config kuralı (`device.profile`) | **tek başına yetmiyor** — kayıtlı durum onu eziyor |

Belirleyici kanıt: kural kurulduktan sonra cihaz hâlâ `iec958`'deydi ve
`~/.local/state/wireplumber/default-profile` şu satırı taşıyordu:

```
alsa_card.usb-Sony_INZONE_Buds-00=output:iec958-stereo+input:mono-fallback
```

Dosyanın zaman damgası `wpctl set-profile` çağrısından **önceydi** — yani o
komut state'i hiç güncellememişti. Satır `pro-audio` yapılınca dongle çıkarılıp
takıldıktan sonra bile iki sink ayakta kaldı.

Bu yüzden `make wireplumber` iki işi birden yapar: config dosyasını kurar
(temiz makinede kayıtlı durum yokken profili seçmesi için) **ve** state
satırını düzeltir. State düzenlenmeden önce WirePlumber durdurulur — servis
çalışırken düzenlenirse çıkarken dosyayı geri yazıp değişikliği ezer.

### Uygulamaları yönlendirme

GNOME'un Ses paneli uygulama başına **ses seviyesi** verir ama uygulama başına
**çıkış cihazı** seçtirmez. İki yol:

- **Uygulamanın kendi ayarı.** Google Meet'te dişli → Ses → Hoparlör:
  `INZONE Buds Pro 1`. Discord, Zoom vb. de kendi çıkış seçicisini sunuyor.
- **`pavucontrol`** — Playback sekmesinden herhangi bir akış sürüklenebilir.

Varsayılan çıkış oyun akışında (`pro-output-0`) kalmalı; yalnızca sesli
görüşme uygulaması sohbet akışına alınır.

### ⚠️ Listede **dört** INZONE görünür, ikisi tuzak

Pro Audio kurulduktan sonra GNOME'un Ses Çıkışı listesi şunu gösterir:

```
Analog Output – INZONE Buds            ← kartın route'u, cihaz DEĞİL
Digital Output (S/PDIF) – INZONE Buds  ← kartın route'u, cihaz DEĞİL
INZONE Buds Pro                        ← pro-output-0, oyun akışı
INZONE Buds Pro 1                      ← pro-output-1, sohbet akışı
```

Ama gerçekte **iki** sink vardır. Ölçüm:

- `wpctl status` → INZONE altında iki sink (`Pro`, `Pro 1`) + bir source
- `pw-cli e <devid> EnumRoute` → üç route: `Headset Microphone`,
  `Analog Output`, `Digital Output (S/PDIF)`

Yani iki çıkış route'u + iki node = listedeki dört satır. Adlandırma da bunu
ele veriyor: GNOME port taşıyan girdileri `port – cihaz` biçiminde yazar
("Speaker – Alder Lake…" gibi); alttaki iki satırda tire yoktur, çünkü onlar
doğrudan node'dur.

**Üstteki iki satıra dokunma.** Onlar ACP profillerine ait çıkışlar; seçilmesi
kartı `pro-audio` dışına çıkarır ve sohbet sink'i kaybolur. *(Route seçmenin
profili geri döndürdüğü doğrudan denenmedi — çıkarım. Olursa `make wireplumber`
düzeni geri kurar.)*

Günlük kullanım: varsayılan çıkış **INZONE Buds Pro**'da kalsın, yalnızca sesli
görüşme uygulaması kendi ayarından **INZONE Buds Pro 1**'e alınsın.

### Doğrulanan davranış (2026-09-03)

Google Meet sohbet akışında, Spotify oyun akışında çalarken kaydırıcı iki uca
çekildi: **en solda yalnız görüşme sesi**, sağa gittikçe müzik giriyor, en
sağda müzik tam güçte. Yani `0x22` gerçekten iki akış arasında çapraz geçiş
yapıyor ve Quick Settings kaydırıcısı amacına ulaşıyor.

### Bedeli

`pro-audio` profili ALSA'nın kanal/format dönüşümlerini ve ACP mikser
yönlendirmesini devre dışı bırakır; ses seviyesi yazılımsal olur. Günlük
kullanımda sorun çıkarmadı, ama donanım mikserinden gelen bir davranış
beklenmemeli.

Kurulum **reboot'tan sağ çıktı** (2026-09-03) — dongle çıkar-tak testinden
daha güçlü bir doğrulama.

Geri almak için: `make wireplumber-uninstall`
