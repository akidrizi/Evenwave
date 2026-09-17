NAME    := evenwave
VERSION := $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)
SHIP    := manifest.json content.js popup.html popup.js icons
OUT     := dist/$(NAME)
ZIP     := dist/$(NAME)-$(VERSION).zip

.PHONY: build zip clean

# Unpacked build -> chrome://extensions -> Load unpacked -> dist/evenwave
build:
	rm -rf $(OUT)
	mkdir -p $(OUT)
	cp -R $(SHIP) $(OUT)/
	@echo "unpacked -> $(OUT)"

# Store-ready zip, manifest.json at the archive root
zip: build
	rm -f $(ZIP)
	cd $(OUT) && { zip -qr ../$(NAME)-$(VERSION).zip . 2>/dev/null || powershell -NoProfile -Command "Compress-Archive -Path * -DestinationPath ../$(NAME)-$(VERSION).zip -Force"; }
	@echo "zip -> $(ZIP)"

clean:
	rm -rf dist
