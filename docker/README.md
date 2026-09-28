# Running in Docker

## Deploying to a server

1. **Copy the project to the server.** `node_modules` and `.next` aren't needed;
   they're rebuilt inside the image:

   ```bash
   rsync -a --exclude node_modules --exclude .next ./ user@server:/opt/pointcloud/
   ```

2. **Put the data on the server.** Leave it in `public/tonga`, or put it anywhere
   and set `DATA_PATH` to that folder. It's mounted read-only and never copied into
   the image.

3. **Run the script** on the server:

   ```bash
   cd /opt/pointcloud
   ./docker/deploy.sh          # first run creates docker/.env; fill in the token, username and password
   ./docker/deploy.sh          # then run it again: checks, builds, starts, verifies
   ```

4. **Add the nginx block** the script prints, then reload nginx.

Later:
- `./docker/deploy.sh` redeploys after code changes.
- `./docker/deploy.sh restart` restarts after you replace data files.
- `status`, `logs` and `down` do what they say.
- `check` validates the settings and data without touching Docker.

## By hand

```bash
cp docker/.env.example docker/.env     # fill in the token, password and secret
docker compose -f docker/docker-compose.yml up -d --build
```

The app listens on `127.0.0.1:3120` (`APP_PORT` / `APP_BIND` in `docker/.env`).
nginx serves it at https://opmthredds.gem.spc.int/pointcloud.

Everything lives under `/pointcloud`:

| Path | What |
|---|---|
| `/pointcloud` | 3D viewer |
| `/pointcloud/products` | Products map |
| `/pointcloud/login` | Sign in |
| `/pointcloud/data/...` | Guarded data route |

The prefix is Next's `basePath`, fixed at build time. To change it, edit
`next.config.ts` and `lib/basePath.ts`, then rebuild.

## nginx

Pass `/pointcloud` through **without stripping the prefix**: the app expects it.

```nginx
location ^~ /pointcloud {
    proxy_pass http://127.0.0.1:3120;          # no trailing slash or path: keep /pointcloud
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $remote_addr;   # overwrite: the download limit counts per IP
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

The app builds its login redirects from `X-Forwarded-Host` and
`X-Forwarded-Proto`. The session cookie is limited to `Path=/pointcloud`, so it
isn't sent to other apps on the same domain.

## Login

In Docker the **whole app** needs a login: `APP_USERNAME` and `APP_PASSWORD` in
`docker/.env`. The data route refuses every file without a session.

Running locally (`npm run dev`, no credentials set) there's no login at all.
The login turns on exactly when both variables are set, and never falls back
to a default password.

## The data

Your data folder (`DATA_PATH`, default `../public/tonga`) is mounted **read-only**
at `/data/tonga`. It is never copied into the image.

The folder must contain:
- `topobathy.copc.laz`
- `terrain.pmtiles`
- `ortho.pmtiles`
- `buildings.geojson`
- `vegetation.geojson`
- `products/`

To update the data, replace the files on the host. No rebuild is needed.

## How the data is protected

The only way to the files is the app's `/pointcloud/data` route. It serves them only if every
check below passes:

| Check | Stops |
|---|---|
| Signed-in session: every page and every data file | Anyone without the username and password |
| `Sec-Fetch-Site: same-origin` | Opening a file URL in the browser, hotlinking, plain scripts |
| COPC / PMTiles only in pieces, max `DATA_MAX_RANGE_MB` | Downloading a whole file in one request |
| `DATA_RATE_MB` per `DATA_RATE_WINDOW_S` per session | Scraping a whole file piece by piece |
| Known file types only; no listings; paths can't leave `/data` | Browsing or reaching other files |

The old public path `/pointcloud/tonga/...` is closed.

**Limit:** the viewer has to download pieces of the data to draw them. A signed-in
user who is determined can still capture what their own browser loads. These
checks make that slow, and keep everyone else out entirely.

## Container hardening

- Runs as an unprivileged user (uid 1001).
- The file system is read-only; only `/tmp` and Next's cache are in-memory mounts.
- All Linux capabilities are dropped, and it can't gain new privileges.
- Process count is limited, and there's a health check on `/pointcloud/login`.

## Going live

1. Put the container behind a reverse proxy with HTTPS (Caddy, nginx, Traefik).
2. `APP_BIND=127.0.0.1` (the default) means only nginx can reach the app.
3. `COOKIE_SECURE=true` (the default) because nginx serves HTTPS.
4. Use a long random `AUTH_SECRET`. Changing it signs everyone out.
