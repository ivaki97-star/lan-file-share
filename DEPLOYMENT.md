# Deployment guidebook

For deploying LAN File Share on a server that **already runs other things** (nginx sites, other Node or Docker
services, databases). The first rule: nothing that runs there today may stop working. Whoever does this, person or
agent, follows the phases in order and does not skip the discovery phase.

## 0. What this app needs

- Node.js 20.12 or newer (uses `process.loadEnvFile`; 22+ preferred). No npm install, no build step.
- One TCP port on localhost for Node, chosen to be free (see phase 1). Defaults to 8080, which is often taken.
- A reverse proxy in front for HTTPS. nginx is assumed below; if the server uses Caddy or Traefik, translate.
- A data directory outside the checkout, writable by the service user. Uploads can be large (game folders).
- Outbound HTTPS (title lookups for mod links). Optional: outbound TCP to the Minecraft server for the online list.
- Settings come from `.env` next to `server.js`; see `.env.example`.

The app talks plain HTTP, long-polls nothing (short polls every few seconds), and streams uploads with `PUT` bodies
that can be gigabytes. The proxy must not buffer or cap those.

## 1. Discover before touching anything

Run these and keep the output. Decisions in later phases depend on it.

```bash
# who listens where (the port we pick must NOT appear here)
sudo ss -tlnp
# every service that is running; note names so ours does not collide
systemctl list-units --type=service --state=running --no-pager
# nginx: full effective config, every server_name, listen and upstream in use
sudo nginx -T 2>/dev/null | grep -nE 'server_name|listen |proxy_pass|upstream|include ' 
ls /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null
# TLS: how certificates are managed today (certbot? acme.sh? Caddy?)
sudo certbot certificates 2>/dev/null; ls /etc/letsencrypt/live 2>/dev/null
# Node available? which version? (nvm installs are per user, check the service user too)
node --version; which node
# firewall
sudo ufw status 2>/dev/null; sudo iptables -L -n 2>/dev/null | head -30
# disk for the data directory
df -h
```

From this, write down:

| Decision | Value | Rule |
|---|---|---|
| App port | e.g. `8087` | Not in `ss -tlnp`, not in any nginx `proxy_pass`, not in any docker-compose on the box. Pick one and keep it. |
| Host name | e.g. `share.example.com` | Must not already be a `server_name` in nginx. Needs a DNS record to this server. |
| Service name | `lan-file-share` | Must not already exist in `systemctl list-units`. |
| Service user | `lanshare` | New system user; never reuse another service's user. |
| Data dir | `/var/lib/lan-file-share` | On the disk with the most free space. |
| TLS method | whatever is already used | If certbot manages nginx certs, use `certbot --nginx -d <host>`; do not install a second ACME client. |

If any of these collide, change ours, never theirs.

## 2. Install the app

```bash
sudo useradd -r -m -d /opt/lan-file-share -s /usr/sbin/nologin lanshare
sudo -u lanshare git clone https://github.com/ivaki97-star/lan-file-share /opt/lan-file-share
sudo mkdir -p /var/lib/lan-file-share && sudo chown lanshare:lanshare /var/lib/lan-file-share
sudo -u lanshare cp /opt/lan-file-share/.env.example /opt/lan-file-share/.env
sudo -u lanshare nano /opt/lan-file-share/.env
```

`.env` for a shared server (values from phase 1):

```
MODE=hosted
AUTH=on
PORT=8087
BIND=127.0.0.1
DATA_DIR=/var/lib/lan-file-share
PUBLIC_URL=https://share.example.com
INVITE_CODE=<something the group gets>
ADMIN_TOKEN=<long random string, e.g. openssl rand -hex 32>
TRUST_PROXY=on
MC_SERVER=<minecraft host>:25565
```

`BIND=127.0.0.1` is not optional on a shared server: only nginx may reach Node. `PUBLIC_URL` must be the final https
address; it is written into every installer download.

If Node is missing or too old and other services depend on the system Node, install a separate one for this user
only (nvm under `/opt/lan-file-share`, or a tarball under `/opt/node22`) and point the unit's `ExecStart` at it.
Do not upgrade the system Node that other services use.

## 3. Bring the data over

From the LAN PC: `node server.js --export backup.zip`, or the admin's "Export data" link, or just a zip of the whole
app folder. Copy it to the server, then with the service **not running**:

```bash
sudo -u lanshare DATA_DIR=/var/lib/lan-file-share node /opt/lan-file-share/server.js --import /tmp/backup.zip
```

It prints how many files it restored. Importing again overwrites files with the same name and keeps the rest.

## 4. Run it as a service

`deploy/lan-file-share.service` is a template. Set `User`, `WorkingDirectory`, `ExecStart` (full path to the right
`node`), and make sure the unit name is unique on this box.

```bash
sudo cp /opt/lan-file-share/deploy/lan-file-share.service /etc/systemd/system/lan-file-share.service
sudo systemctl daemon-reload && sudo systemctl enable --now lan-file-share
sudo systemctl status lan-file-share --no-pager
curl -s http://127.0.0.1:8087/api/me      # expect {"auth":true,...}
```

The start log prints the mode, the data paths and warnings (open registration, missing admin token). Fix warnings
before going public.

## 5. nginx: add a site, change nothing else

Create **a new file** for this host only. Do not edit files belonging to other sites, and do not touch the default
server. Example `/etc/nginx/sites-available/lan-file-share.conf`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name share.example.com;

    # Uploads are big game folders streamed file by file; never buffer or cap them here.
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:8087;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then:

```bash
sudo ln -s /etc/nginx/sites-available/lan-file-share.conf /etc/nginx/sites-enabled/
sudo nginx -t                      # must pass; if it fails, remove the symlink, nothing else changed
sudo systemctl reload nginx        # reload, not restart: other sites keep serving
sudo certbot --nginx -d share.example.com   # only if certbot already manages this nginx; it adds the 443 block
sudo nginx -t && sudo systemctl reload nginx
```

If `listen 80` is served by a different default server with a wildcard `server_name`, ours still wins for its exact
host name. If the box uses `conf.d/*.conf` instead of `sites-enabled`, put the file there. If certificates come from
another tool, obtain one the same way the other sites do and add the `listen 443 ssl` block by hand.

Verify from outside: `curl -sI https://share.example.com/` returns `200` and the HTML; `curl -s https://share.example.com/api/me`
returns JSON. Then open the site, register the first account (it becomes admin), and check the banner, Models tab and
Accounts panel.

## 6. After going live

- Hand out `INVITE_CODE`; everyone registers and re-downloads the installer while signed in.
- Minecraft server: `tools/deploy-server.cmd` into the server folder with `SiteUrl=https://share.example.com` and the
  `ADMIN_TOKEN`; run with the server stopped.
- Backups: `sudo -u lanshare DATA_DIR=/var/lib/lan-file-share node /opt/lan-file-share/server.js --export /backup/lfs-$(date +%F).zip`
  from a daily cron. Keep `secret.key` out of backups you share; losing it only logs everyone out.
- Updates: `cd /opt/lan-file-share && sudo -u lanshare git pull && sudo systemctl restart lan-file-share`. The data
  directory is untouched by updates.
- The online-players line needs the Minecraft server's port reachable from this server. If the Minecraft server sits
  on a home connection without port forwarding, leave `MC_SERVER` empty rather than showing it as offline.

## 7. Rollback

```bash
sudo systemctl disable --now lan-file-share
sudo rm /etc/nginx/sites-enabled/lan-file-share.conf && sudo nginx -t && sudo systemctl reload nginx
```

Data stays in `/var/lib/lan-file-share`. Nothing else on the server was changed, so nothing else needs restoring.

## Checklist for the agent doing this

- [ ] Phase 1 output saved; port, host name, service name, user and data dir chosen with no collisions.
- [ ] No existing nginx file edited; new file only; `nginx -t` passed; `reload`, not `restart`.
- [ ] System Node untouched if other services use it.
- [ ] `BIND=127.0.0.1`, `PUBLIC_URL` https, `INVITE_CODE` and `ADMIN_TOKEN` set, `TRUST_PROXY=on`.
- [ ] Data imported before first public start; first account registered by the admin.
- [ ] `ss -tlnp` afterwards shows only the one new listener on 127.0.0.1:<port>.
