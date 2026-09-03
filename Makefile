UUID    := inzone@soylu.me
SRC     := src/$(UUID)
DEST    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
UDEV    := /etc/udev/rules.d/60-inzone.rules
WPCONF  := $(HOME)/.config/wireplumber/wireplumber.conf.d/51-inzone-pro-audio.conf

.PHONY: help check install uninstall udev udev-uninstall wireplumber wireplumber-uninstall pack

help:
	@echo "make check           — sozdizimi + protokol testleri (node gerekir)"
	@echo "make install         — extension'i ~/.local/share/... altina kur"
	@echo "make uninstall       — kaldir"
	@echo "make udev            — hidraw erisim kuralini kur (sudo)"
	@echo "make udev-uninstall  — kurali kaldir (sudo)"
	@echo "make wireplumber     — dongle'i Pro Audio profiline sabitle (iki sink)"
	@echo "make wireplumber-uninstall — kurali kaldir"
	@echo "make pack            — dagitim icin zip"
	@echo ""
	@echo "Kurulumdan sonra oturumu kapatip acmak gerekir (Wayland'de Alt+F2 r yok)."

check:
	@echo "== JS sozdizimi"
	@for f in $(SRC)/*.js tools/gjs-probe.js; do \
		cp $$f /tmp/_chk.mjs && node --check /tmp/_chk.mjs || exit 1; \
		echo "   ok $$f"; \
	done; rm -f /tmp/_chk.mjs
	@echo "== metadata.json"
	@python3 -c "import json,sys; d=json.load(open('$(SRC)/metadata.json')); \
		assert d['uuid']=='$(UUID)', 'uuid uyusmuyor'; \
		assert d['shell-version'], 'shell-version bos'; \
		print('   ok', d['uuid'], d['shell-version'])"
	@echo "== protokol testleri (JS — gercek yakalanan cercevelere karsi)"
	@node tools/js-selftest.mjs | tail -3
	@echo "== protokol testleri (Python)"
	@python3 tools/selftest.py | tail -3

# BILEREK 'check'e bagimli DEGIL. Bagimliyken hedef makinede node kurulu
# olmadiginda 'make install' testlerde durup kurulumu hic yapmiyordu, ustelik
# cikti "kuruldu" satirini icermedigi icin bu fark edilmiyordu. Testler
# gelistirme makinesinde kosar; kurulum yalnizca dosya kopyalar.
install:
	@mkdir -p $(DEST)
	@cp -f $(SRC)/*.js $(SRC)/metadata.json $(DEST)/
	@echo "kuruldu: $(DEST)"
	@echo "Oturumu kapatip acin, sonra: gnome-extensions enable $(UUID)"

uninstall:
	@rm -rf $(DEST)
	@echo "kaldirildi: $(DEST)"

udev:
	@sudo install -m 0644 udev/60-inzone.rules $(UDEV)
	@sudo udevadm control --reload-rules
	@sudo udevadm trigger --subsystem-match=hidraw
	@echo "kuruldu: $(UDEV)"
	@echo "Dongle'i cikarip takin; sonra 'ls -l /dev/hidraw*' ile ACL'i dogrulayin"
	@echo "(satirda + isareti olmali, ornek: crw-rw----+ root root)."

udev-uninstall:
	@sudo rm -f $(UDEV)
	@sudo udevadm control --reload-rules
	@echo "kaldirildi: $(UDEV)"

# Oyun/sohbet dengesinin ise yaramasi icin iki sink gerekiyor; gerekce
# wireplumber/51-inzone-pro-audio.conf basinda. sudo GEREKMEZ, kullanici config'i.
wireplumber:
	@mkdir -p $(dir $(WPCONF))
	@cp -f wireplumber/51-inzone-pro-audio.conf $(WPCONF)
	@systemctl --user restart wireplumber
	@echo "kuruldu: $(WPCONF)"
	@echo "Dogrulama: wpctl status | grep -i inzone  -> IKI sink gorunmeli"
	@echo "(pro-output-0 = oyun, pro-output-1 = sohbet)"

wireplumber-uninstall:
	@rm -f $(WPCONF)
	@systemctl --user restart wireplumber
	@echo "kaldirildi: $(WPCONF)"

pack: check
	@rm -f $(UUID).zip
	@cd $(SRC) && zip -q -r ../../$(UUID).zip *.js metadata.json
	@echo "olusturuldu: $(UUID).zip"
