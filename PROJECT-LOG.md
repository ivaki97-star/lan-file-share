# Project log

What exists, why, and what is next. Newest work at the bottom of each section. Dates are 2026.

## The pieces

| Piece | Where | Purpose |
|---|---|---|
| LAN File Share site | this repo, `server.js` + `public/` | Files, chat, mod lists, places, installer versions, models. Node, no dependencies. |
| Mods installer | `tools/Install-MinecraftMods.cmd` (source), released through the site as "Mods Installer vX" | One double-click on a player's PC: installs Fabric, the mods and the models for the server. |
| Pack definition | `pack.json` inside each installer version | Minecraft version, Fabric Loader, mod list, model feed address, report address. |
| Deploy command | `tools/deploy-server.cmd` | Run in the Minecraft server folder: pulls the current pack from the site, installs it into the server, reports it. |
| Apply models (older path) | `tools/apply-models.cmd` | Copies a downloaded `models.zip` into the server's mods folder. Superseded by the deploy command, kept for offline use. |
| Minecraft server | `D:\MinecraftServer` on the admin's PC | Minecraft 26.3, Fabric Loader 0.19.5. Launch with `start-server.cmd` (never `server.jar`). |

## Done

### Oct 10 — installer and server mods
- Found that Boat Fly is a Fabric-only mod and needs Fabric Loader 0.19.5+, Fabric API and Java 25; built the installer
  around that. The installer finds the Minecraft folder on any drive, finds Java (launcher runtime, JAVA_HOME, PATH),
  installs Fabric headlessly for both launcher types, creates the launcher profile, verifies downloads by checksum,
  keeps a manifest of what it installed so dropped mods get removed, writes a log, and never closes on an error.
- Single-file `.cmd` that is really PowerShell (polyglot header), so double-click works without execution-policy prompts.
- Pack definition moved into `pack.json`; folder `MinecraftModPack` with README for maintainers; mods can be bundled as
  local files, pinned by URL + SHA-256, or looked up on Modrinth.
- Server and pack brought to the same set: Fabric API 0.162.0, Boat Fly 7.0.0, Easy NPC 7.14.0 (core, config UI,
  bundle), Player Animation Library 1.2.8, Emotecraft 3.5.0 alpha, Easy Model Entities 2.4.0. Easy NPC skins and
  model lookups verified against the mod sources.
- Not installed: Emotecraft x Easy NPC (NPC dancing). It hard-requires Minecraft 1.21.x; no 26.3 build of it or of
  any alternative exists (checked EmoteNPC, NPCPremium, NarrativeCraft). Dancer NPC is the in-house answer.
- Findings documented: Easy NPC editor opens with the wand or `/easy_npc configure`, not sneak + right-click; custom
  skins are client-side files; Easy Model Entities models are jars for both server and clients.

### Oct 11 — site: models, 3D preview, auto releases
- Models tab: upload an Easy Model Entities pack (jar or exporter zip); the server validates the layout, adds
  `fabric.mod.json` / `pack.mcmeta` when missing, extracts texture previews, shows summon commands.
- Skins: PNGs baked into the model jar as extra textures, with the per-entity `texture set` command on the card.
- 3D preview per model: dependency-free WebGL viewer for `.bbmodel` (cubes, bones, keyframe animations, drag to
  rotate, click a texture to try it).
- "Download all for the server" marks models uploaded and auto-publishes the next installer version with the model
  feed address and jars written into its `pack.json`; the installer reads the feed live (`modListUrls`).

### Oct 11 — hosted mode
- `.env` switch: `MODE=hosted` turns on accounts (invite code, first user admin, scrypt, signed cookies), admin by role,
  `DATA_DIR`, `PUBLIC_URL`, `ADMIN_TOKEN`, `TRUST_PROXY`, `BIND`. LAN mode unchanged by default.
- Install tracking: a signed-in player's installer download carries a personal token; the installer reports the
  installed version; banner and Accounts panel show who is current. Manual "I installed vX" link.
- Deploy command for the Minecraft server (installer in server mode + deploy report), shown in the banner.
- Export/import of the whole data folder (`--export`, `--import`, admin Export link); the import also accepts a zip
  of the whole app folder, nested or not.
- Changelog per installer version (mods added / removed / changed), online-players line from a Minecraft status ping
  (`MC_SERVER`).
- Friend's data imported and verified on a staging run: 21 chat messages, 9 mods, 6 places, 2 versions, 1 model.

### Oct 11 — suggestions to server pack
- Mod suggestions tab: admin ticks suggestions (select all), "Publish selected to the server pack". The site resolves
  Modrinth / CurseForge / direct jar links for the pack's Minecraft version, downloads and checks the jars, bundles them
  into the next installer version (`POST /api/mods/publish`). The deploy report from the Minecraft server marks the
  suggestions installed, with the version. Cards show "in vX, waiting for the server deploy" and fetch errors.
- Version zips always carry `tools/Install-MinecraftMods.cmd` and a model feed pointing at the serving site, so a
  version uploaded with an old installer or made on the LAN PC still deploys in server mode.

## Next steps

1. Deploy the site following `DEPLOYMENT.md`; fill `.env`; import the data; register the first (admin) account.
2. Give the group the invite code. Everyone registers, then downloads the installer again while signed in, so their
   installs get reported.
3. Done 2026-10-11: `deploy-server.cmd` is in `D:\MinecraftServer` with `SiteUrl` and `AdminToken` set; the server
   runs pack 2026-10-12.
4. Look at the Models tab and the sign-in flow in a browser once; they were tested through the API only. If a cube
   face of the 3D preview looks mirrored, the face mapping in `public/model-viewer.js` is the place.
5. Dancer NPC: the `dance` clip is not auto-played by Easy Model Entities; trigger it through Easy NPC's model
   settings or the API. A dancing NPC addon for 26.3 does not exist yet; re-check Modrinth now and then.
6. Clean the loose files at the top of the shared folder (old installer scripts, stray jar, text document).
7. Later, if the group grows: `node:sqlite` is the zero-dependency path to a database; a `/api/export` cron backup
   on the server is cheap insurance either way.
