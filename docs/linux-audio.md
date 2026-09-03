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

⚠️ **`wpctl set-profile` ile elle seçmek kalıcı değil.** Dongle çıkarılıp
takılınca WirePlumber `iec958` profiline geri dönüyor (ölçüldü 2026-09-03);
`wpctl set-default` ile varsayılanı pro-audio node'una taşımak da bunu
engellemedi. Kalıcılık için yukarıdaki config dosyası gerekiyor.

### Uygulamaları yönlendirme

GNOME'un Ses paneli uygulama başına **ses seviyesi** verir ama uygulama başına
**çıkış cihazı** seçtirmez. İki yol:

- **Uygulamanın kendi ayarı.** Google Meet'te dişli → Ses → Hoparlör:
  `INZONE Buds Pro 1`. Discord, Zoom vb. de kendi çıkış seçicisini sunuyor.
- **`pavucontrol`** — Playback sekmesinden herhangi bir akış sürüklenebilir.

Varsayılan çıkış oyun akışında (`pro-output-0`) kalmalı; yalnızca sesli
görüşme uygulaması sohbet akışına alınır.

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

Geri almak için: `make wireplumber-uninstall`
