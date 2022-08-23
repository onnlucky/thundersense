dist/index.js: src/index.ts
	rm -rf dist/*
	tsc

dev:
	yarn dev

install: dist/index.js
	sudo -u homeassistant rm -rf /srv/homeassistant/thundersense-to-homeassistant
	sudo -u homeassistant mkdir -p /srv/homeassistant/thundersense-to-homeassistant
	sudo -u homeassistant cp dist/* /srv/homeassistant/thundersense-to-homeassistant/
	sudo -u homeassistant cp -r node_modules /srv/homeassistant/thundersense-to-homeassistant/

	sudo systemctl stop thundersense-to-homeassistant || true
	sudo cp thundersense-to-homeassistant.service /etc/systemd/system
	sudo systemctl daemon-reload
	sudo systemctl start thundersense-to-homeassistant
	sudo systemctl enable thundersense-to-homeassistant
	sleep 1
	systemctl status thundersense-to-homeassistant
