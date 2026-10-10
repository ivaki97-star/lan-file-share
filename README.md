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
  it in Downloads) and run it. It copies the jars into `mods\`, replacing older builds, and also into the player pack
  folder set at the top of the script, updating that pack's `pack.json`. Then restart the server and upload the re-zipped
  pack as a new installer version.
