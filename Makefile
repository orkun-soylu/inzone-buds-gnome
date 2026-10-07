UUID    := inzone@soylu.me
SRC     := src/$(UUID)
DEST    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
UDEV    := /etc/udev/rules.d/60-inzone.rules

.PHONY: help check install uninstall udev udev-uninstall wireplumber wireplumber-uninstall pack

help:
	@echo "make check           — syntax + protocol tests (needs node and python3)"
	@echo "make install         — install the extension under ~/.local/share/..."
	@echo "make uninstall       — remove it"
	@echo "make udev            — install the hidraw access rule (sudo)"
	@echo "make udev-uninstall  — remove the rule (sudo)"
	@echo "make wireplumber     — pin the dongle to the Pro Audio profile (two sinks)"
	@echo "make wireplumber-uninstall — undo that"
	@echo "make pack            — zip for distribution"
	@echo ""
	@echo "Log out and back in after installing (Wayland has no Alt+F2 r)."

check:
	@echo "== JS syntax"
	@tmp=`mktemp -d`; trap 'rm -rf $$tmp' EXIT; \
	for f in $(SRC)/*.js tools/gjs-probe.js; do \
		cp $$f $$tmp/check.mjs && node --check $$tmp/check.mjs || exit 1; \
		echo "   ok $$f"; \
	done
	@echo "== metadata.json"
	@python3 -c "import json,sys; d=json.load(open('$(SRC)/metadata.json')); \
		assert d['uuid']=='$(UUID)', 'uuid mismatch'; \
		assert d['shell-version'], 'shell-version empty'; \
		print('   ok', d['uuid'], d['shell-version'])"
	@echo "== protocol tests (JS — against frames captured from the device)"
	@node tools/js-selftest.mjs | tail -3
	@echo "== protocol tests (Python)"
	@python3 tools/selftest.py | tail -3

# Deliberately NOT dependent on 'check'. When it was, 'make install' stopped in
# the tests on a machine without node and never installed anything -- and since
# the output had no "installed" line, nobody noticed. Tests run on the
# development machine; installing only copies files.
install:
	@mkdir -p $(DEST)
	@cp -f $(SRC)/*.js $(SRC)/metadata.json $(DEST)/
	@echo "installed: $(DEST)"
	@echo "Log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	@rm -rf $(DEST)
	@echo "removed: $(DEST)"

udev:
	@sudo install -m 0644 udev/60-inzone.rules $(UDEV)
	@sudo udevadm control --reload-rules
	@sudo udevadm trigger --subsystem-match=hidraw
	@echo "installed: $(UDEV)"
	@echo "Unplug and replug the dongle, then check the ACL with 'ls -l /dev/hidraw*'"
	@echo "(the line should carry a +, e.g. crw-rw----+ root root)."

udev-uninstall:
	@sudo rm -f $(UDEV)
	@sudo udevadm control --reload-rules
	@echo "removed: $(UDEV)"

# The game/chat balance is only useful with two sinks. A config rule ALONE is not
# enough -- WirePlumber's saved default-profile state overrides it; the script
# handles both. No sudo needed, it is user config.
wireplumber:
	@./wireplumber/install.sh

wireplumber-uninstall:
	@./wireplumber/uninstall.sh

pack: check
	@rm -f $(UUID).zip
	@cd $(SRC) && zip -q -r ../../$(UUID).zip *.js metadata.json
	@echo "created: $(UUID).zip"
