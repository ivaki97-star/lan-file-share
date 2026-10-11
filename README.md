# LAN File Share

File sharing, chat, mod lists, places and a mods-installer download for a LAN party. No dependencies: `node server.js` (or `start.bat`), then open `http://<host>:8080`.

Everything people upload stays in `shared/` on the host PC, plus a few JSON files next to `server.js`. None of that is in git.

## Models tab (Easy Model Entities)

A model is one `.jar` that holds an [Easy Model Entities](https://modrinth.com/mod/easy-model-entities) pack: the server profile
(`data/<pack>/easy_model_entities/profiles/entity/<name>.json`), the render profile
(`assets/<pack>/easy_model_entities/render_profiles/entity/<name>.json`), the Blockbench model
(`assets/<pack>/easy_model_entities/models/<name>.bbmodel`) and textures (`assets/<pack>/textures/entity/<name>.png`).
Such a jar goes into the `mods` folder on the Minecraft server and on every player, which the mods installer does.

- **Propose a model**: upload the jar, or the zip the Blockbench exporter produces. The server checks the layout, adds
  `fabric.mod.json` and `pack.mcmeta` when they are missing, and shows the textures and animations on a card.
- **Add skin**: a PNG that is baked into the jar as `assets/<pack>/textures/entity/<skin>.png`. The jar gets a new build
  number. In game an op applies it to one entity with the command shown on the card
  (`/easy_model_entities texture set entity <UUID> slot default <pack>:textures/entity/<skin>.png`).
- **Download all for the server**: gives `models.zip` with every jar and marks the models as uploaded. "Update pending"
  means a skin was added after the last download.
- **Server admin**: put `tools/apply-models.cmd` into the Minecraft server folder, drop `models.zip` next to it (or leave
  it in Downloads) and run it. It copies the jars into `mods\`, replacing older builds. Then restart the server.
- **Players**: the mods installer reads `GET /api/models/pack-entries?status=uploaded` (the address is shown on the Models
  tab) when its `pack.json` lists it under `modListUrls`, so uploaded models install and update without a new pack release.

## Hosting on a real server

Everything is switched by a `.env` file next to `server.js` (see `.env.example`). Without one the site runs as the LAN
party share it always was. With `MODE=hosted`:

- **Accounts.** Everyone signs in. Registration needs `INVITE_CODE`; the first account becomes the admin. Admins
  delete things, manage accounts and export data (what the host PC could do on the LAN).
- **Install tracking.** The installer download for a signed-in player carries a personal token in its `pack.json`.
  The installer reports the version it installed; the banner tells each player whether they are current, and the
  Accounts panel shows the admin who is behind.
- **Server deploys.** `tools/deploy-server.cmd` in the Minecraft server folder pulls the current pack with
  `ADMIN_TOKEN`, installs mods and uploaded models into the server, and reports it. The banner shows what the server runs.
- **Model feed and downloads** need a token; the installer sends the player's one, the deploy command the admin one.
- **Changelog** (link in the banner): every installer version with the mods added, removed or changed since the
  version before, computed from each version's pack.json. Players who installed by hand can mark a version as
  installed from the banner.
- **Who is online**: with `MC_SERVER=host:port` in `.env` (works in LAN mode too) the site pings the Minecraft server
  every 30 seconds and shows the player names under the title. Names are hidden if the server sets
  `hide-online-players=true`, and the ping shows at most 12 names.

### Setup (Linux, Node 20.12 or newer)

```
sudo useradd -r -m -d /opt/lan-file-share lanshare
sudo -u lanshare git clone https://github.com/ivaki97-star/lan-file-share /opt/lan-file-share
cd /opt/lan-file-share && sudo -u lanshare cp .env.example .env && sudo -u lanshare nano .env
sudo mkdir -p /var/lib/lan-file-share && sudo chown lanshare /var/lib/lan-file-share
sudo cp deploy/lan-file-share.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now lan-file-share
```

Put Caddy (or nginx) in front for HTTPS: `deploy/Caddyfile` is a complete example. `PUBLIC_URL` must be the https
address, it is written into the installer. Open only ports 80 and 443; `BIND=127.0.0.1` keeps Node off the internet.

### Moving the data from the LAN PC

On the PC that hosted the LAN share: `node server.js --export backup.zip` (or the admin's "Export data" link), or simply
zip the whole app folder; the import finds the data inside it and skips the program files.
On the server, with the service stopped: `sudo -u lanshare DATA_DIR=/var/lib/lan-file-share node server.js --import backup.zip`.
That restores the shared files, chat, mod lists, places, installer versions, models and accounts.

### Updating

`cd /opt/lan-file-share && sudo -u lanshare git pull && sudo systemctl restart lan-file-share`

### Minecraft server side

Copy `tools/deploy-server.cmd` into the server folder, open it in Notepad and set `SiteUrl` and `AdminToken`.
Stop the server, run it, start the server. Launch the server with `fabric-server-launch.jar` (never `server.jar`).
