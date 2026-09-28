#!/usr/bin/env bash
#
# Deploy the Pacific Ocean Portal with Docker on this server.
#
#   ./docker/deploy.sh            check, build, start, verify   (default)
#   ./docker/deploy.sh deploy fix same, and make the data readable by the container
#   ./docker/deploy.sh check      only check config and data; no Docker needed
#   ./docker/deploy.sh status     container state and health
#   ./docker/deploy.sh logs       follow the app's logs
#   ./docker/deploy.sh restart    restart without rebuilding (e.g. after replacing data)
#   ./docker/deploy.sh down       stop and remove the container
#
# Run it from anywhere inside the copied project. Settings live in docker/.env,
# created from docker/.env.example on the first run.

set -euo pipefail

DOCKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$DOCKER_DIR/.." && pwd)"
ENV_FILE="$DOCKER_DIR/.env"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"
BASE_PATH="/pointcloud"
APP_UID=1001   # the container's unprivileged user; it must be able to read the data

# The files the app loads from the data folder.
REQUIRED_DATA=(
  topobathy.copc.laz
  terrain.pmtiles
  ortho.pmtiles
  buildings.geojson
  vegetation.geojson
  products/manifest.json
)

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B= G= Y= R= N=; fi
step() { echo; echo "${B}==> $*${N}"; }
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
die()  { echo "  ${R}✗ $*${N}" >&2; exit 1; }

# --------------------------------------------------------------------------

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  else
    die "Docker Compose not found (install the docker-compose-plugin package)"
  fi
}

check_tools() {
  step "Checking tools"
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "cannot talk to Docker (is it running? is $USER in the docker group?)"
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  if docker compose version >/dev/null 2>&1; then ok "$(docker compose version | head -1)";
  elif command -v docker-compose >/dev/null 2>&1; then ok "$(docker-compose version | head -1)";
  else die "Docker Compose not found (install the docker-compose-plugin package)"; fi
  command -v curl >/dev/null 2>&1 || die "curl is not installed (needed for the checks after deploy)"
  ok "curl"
}

env_get() {  # value of KEY in docker/.env, empty if unset
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

env_set() {  # set KEY=VALUE in docker/.env
  local key=$1 value=$2
  if grep -qE "^[[:space:]]*$key=" "$ENV_FILE"; then
    sed -i.bak -E "s|^[[:space:]]*$key=.*|$key=$value|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    echo "$key=$value" >> "$ENV_FILE"
  fi
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

check_env() {
  step "Checking settings ($ENV_FILE)"
  if [ ! -f "$ENV_FILE" ]; then
    cp "$DOCKER_DIR/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    env_set AUTH_SECRET "$(random_secret)"
    warn "created docker/.env from the example, with a random AUTH_SECRET"
    die "fill in NEXT_PUBLIC_CESIUM_ION_TOKEN, APP_USERNAME and APP_PASSWORD in docker/.env, then run this again"
  fi
  chmod 600 "$ENV_FILE"

  if [ -z "$(env_get AUTH_SECRET)" ]; then
    env_set AUTH_SECRET "$(random_secret)"
    ok "generated a random AUTH_SECRET"
  fi

  local missing=()
  for key in NEXT_PUBLIC_CESIUM_ION_TOKEN APP_USERNAME APP_PASSWORD AUTH_SECRET; do
    [ -n "$(env_get "$key")" ] || missing+=("$key")
  done
  [ ${#missing[@]} -eq 0 ] || die "set these in docker/.env: ${missing[*]}"
  ok "token, username, password and secret are set"

  local pw; pw="$(env_get APP_PASSWORD)"
  [ ${#pw} -ge 12 ] || warn "APP_PASSWORD is short (${#pw} characters); use 12 or more"
  [ "$(env_get APP_BIND)" = "127.0.0.1" ] || [ -z "$(env_get APP_BIND)" ] || warn "APP_BIND is not 127.0.0.1: the app is reachable without nginx; set APP_BIND=127.0.0.1 behind nginx"
  [ "$(env_get COOKIE_SECURE)" != "false" ] || warn "COOKIE_SECURE is not true: set it once nginx serves HTTPS"
  return 0
}

data_dir() {  # DATA_PATH as an absolute path; relative paths are relative to docker/
  local p
  p="$(env_get DATA_PATH)"
  p="${p:-../public/tonga}"
  case "$p" in /*) ;; *) p="$DOCKER_DIR/$p" ;; esac
  (cd "$p" 2>/dev/null && pwd) || echo "$p"
}

check_data() {
  local dir fix_perms=${1:-}
  dir="$(data_dir)"
  step "Checking data ($dir)"
  [ -d "$dir" ] || die "data folder not found: $dir (set DATA_PATH in docker/.env)"

  local missing=0 f size
  for f in "${REQUIRED_DATA[@]}"; do
    if [ -f "$dir/$f" ]; then
      size=$(du -h "$dir/$f" | cut -f1)
      ok "$f ($size)"
    else
      warn "missing: $f"; missing=1
    fi
  done
  [ $missing -eq 0 ] || die "the data folder is incomplete"

  # The container runs as uid $APP_UID, not as the file owner: files must be
  # world-readable and folders world-searchable.
  local unreadable
  unreadable=$(find "$dir" \( -type f ! -perm -o=r \) -o \( -type d ! -perm -o=x \) 2>/dev/null | head -5)
  if [ -n "$unreadable" ]; then
    if [ "$fix_perms" = "fix" ]; then
      chmod -R o+rX "$dir" && ok "made the data readable by the container (chmod -R o+rX)"
    else
      echo "$unreadable" | sed 's/^/    /'
      die "the container (uid $APP_UID) can't read the files above; run  chmod -R o+rX '$dir'  or  ./docker/deploy.sh deploy fix"
    fi
  else
    ok "readable by the container (uid $APP_UID)"
  fi
  ok "will be mounted read-only at /data/tonga"
}

wait_healthy() {
  step "Waiting for the app to become healthy"
  local id state i
  id="$(compose ps -q web)"
  [ -n "$id" ] || die "container did not start; see: ./docker/deploy.sh logs"
  for i in $(seq 1 60); do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo gone)"
    case "$state" in
      healthy) ok "healthy"; return 0 ;;
      unhealthy|exited|dead|gone)
        compose logs --tail 40 web || true
        die "container is $state" ;;
    esac
    sleep 2
  done
  compose logs --tail 40 web || true
  die "not healthy after 2 minutes"
}

smoke_test() {
  step "Checking the running app"
  local port base code jar
  port="$(env_get APP_PORT)"; port="${port:-3120}"
  base="http://127.0.0.1:$port$BASE_PATH"
  jar="$(mktemp)"

  code=$(curl -s -o /dev/null -w '%{http_code}' "$base")
  [ "$code" = "307" ] && ok "viewer needs a login (307 to $BASE_PATH/login)" || die "viewer returned $code, expected a redirect to login"

  code=$(curl -s -o /dev/null -w '%{http_code}' "$base/products")
  [ "$code" = "307" ] && ok "products need a login (307)" || die "products returned $code, expected a redirect to login"

  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Sec-Fetch-Site: same-origin" -r 0-99 "$base/data/tonga/topobathy.copc.laz")
  [ "$code" = "401" ] && ok "data needs a login, even with a faked browser header (401)" || die "data without login returned $code, expected 401"

  curl -s -o /dev/null -c "$jar" -X POST --data-urlencode "username=wrong" --data-urlencode "password=wrong" "$base/api/login"
  grep -q pop_session "$jar" && die "wrong credentials were accepted" || ok "wrong credentials are refused"

  curl -s -o /dev/null -c "$jar" -X POST --data-urlencode "username=$(env_get APP_USERNAME)" \
    --data-urlencode "password=$(env_get APP_PASSWORD)" --data-urlencode "next=$BASE_PATH" "$base/api/login"
  grep -q pop_session "$jar" && ok "signing in with the docker/.env credentials works" || die "sign-in with the configured credentials failed"

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$base")
  [ "$code" = "200" ] && ok "viewer opens when signed in (200)" || die "viewer returned $code when signed in"

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -r 0-99 "$base/data/tonga/terrain.pmtiles")
  [ "$code" = "403" ] && ok "signed in, data still can't be downloaded directly (403)" || die "direct data download returned $code, expected 403"

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -H "Sec-Fetch-Site: same-origin" -r 0-16383 "$base/data/tonga/terrain.pmtiles")
  [ "$code" = "206" ] && ok "the viewer can read its data (206)" || die "viewer data returned $code, expected 206"
  rm -f "$jar"
}

print_nginx() {
  local port; port="$(env_get APP_PORT)"; port="${port:-3120}"
  step "nginx"
  cat <<EOF
  Add to the server { } block, then:  sudo nginx -t && sudo systemctl reload nginx

  location ^~ $BASE_PATH {
    proxy_pass http://127.0.0.1:$port;   # no trailing slash: the app expects the $BASE_PATH prefix
    proxy_http_version 1.1;

    proxy_set_header Host              \$host;
    proxy_set_header X-Forwarded-Host  \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    # Overwrite, don't append: the app's download limit counts per client IP.
    proxy_set_header X-Forwarded-For   \$remote_addr;
    proxy_set_header X-Real-IP         \$remote_addr;

    # The viewer streams the point cloud and tiles in byte ranges.
    proxy_buffering off;
    proxy_read_timeout 300s;
  }
EOF
}

# --------------------------------------------------------------------------

cmd="${1:-deploy}"
case "$cmd" in
  check)
    check_env
    check_data
    echo; ok "ready to deploy: ./docker/deploy.sh"
    ;;
  deploy)
    echo "${B}Pacific Ocean Portal: deploying from $PROJECT_DIR${N}"
    check_tools
    check_env
    check_data "${2:-}"
    step "Building the image"
    compose build --pull
    step "Starting the container"
    compose up -d --remove-orphans
    wait_healthy
    smoke_test
    docker image prune -f >/dev/null 2>&1 || true
    print_nginx
    echo; echo "${G}${B}Deployed.${N} $BASE_PATH (login: APP_USERNAME / APP_PASSWORD from docker/.env)"
    ;;
  status)
    compose ps
    ;;
  logs)
    compose logs -f --tail 100 web
    ;;
  restart)
    check_data
    compose restart web
    wait_healthy
    smoke_test
    ;;
  down)
    compose down
    ok "stopped"
    ;;
  -h|--help|help)
    sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    die "unknown command: $cmd (try: deploy, check, status, logs, restart, down)"
    ;;
esac
