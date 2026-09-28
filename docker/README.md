# Running in Docker

```bash
cp docker/.env.example docker/.env     # fill in the token, password and secret
docker compose -f docker/docker-compose.yml up -d --build
```

Open http://localhost:3000/pointcloud and sign in.

Everything lives under `/pointcloud`:

| Path | What |
|---|---|
| `/pointcloud` | 3D viewer (public) |
| `/pointcloud/products` | Products map (password) |
| `/pointcloud/login` | Sign in |
| `/pointcloud/data/...` | Guarded data route |

The prefix is Next's `basePath`, fixed at build time. To change it, edit
`next.config.ts` and `lib/basePath.ts`, then rebuild.

## nginx

Pass `/pointcloud` through **without stripping the prefix**: the app expects it.

```nginx
location /pointcloud {
    proxy_pass http://127.0.0.1:3000;          # no trailing slash or path: keep /pointcloud
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
}
```

The app builds its login redirects from `X-Forwarded-Host` and
`X-Forwarded-Proto`. The session cookie is limited to `Path=/pointcloud`, so it
isn't sent to other apps on the same domain.

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
| Signed-in session cookie, for the products pages and `products/` data only (the 3D viewer is public) | Anyone without the password |
| `Sec-Fetch-Site: same-origin` | Opening a file URL in the browser, hotlinking, plain scripts |
| COPC / PMTiles only in pieces, max `DATA_MAX_RANGE_MB` | Downloading a whole file in one request |
| `DATA_RATE_MB` per `DATA_RATE_WINDOW_S`, per session or per IP if not signed in | Scraping a whole file piece by piece |
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
2. Set `APP_BIND=127.0.0.1` so only the proxy can reach it.
3. Set `COOKIE_SECURE=true`.
4. Use a long random `AUTH_SECRET`. Changing it signs everyone out.
