#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT/.env.single"
PASSWORD_FILE=''
CHECK_ONLY=0
usage() {
  cat <<'HELP'
Usage: bash scripts/install-linux.sh [options]
Build and start the single-container Linux amd64 distribution from this checkout.
  --check                 Check Docker/Compose prerequisites only
  --password-file PATH    Owner-only file containing the initial admin password
  --data-dir PATH         Absolute persistent data directory (no spaces)
  --bind ADDRESS          Published bind address (default 127.0.0.1)
  --public-origin ORIGIN  Exact HTTPS/HTTP origin when using a reverse proxy
  --port NUMBER           Published port (default 5140)
  --help                  Show this help
No Docker installation, production migration, or registry publication is performed.
HELP
}
# Load only known non-secret fields; never execute the environment file.
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      YESIMBOT_DATA_DIR|YESIMBOT_BIND|YESIMBOT_PORT|ADMIN_PUBLIC_ORIGIN) printf -v "$key" '%s' "$value" ;;
    esac
  done < "$ENV_FILE"
fi
while (($#)); do
  case "$1" in
    --help) usage; exit 0 ;;
    --check) CHECK_ONLY=1; shift ;;
    --password-file|--data-dir|--bind|--port|--public-origin)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in
        --password-file) PASSWORD_FILE=$2 ;;
        --data-dir) YESIMBOT_DATA_DIR=$2 ;;
        --bind) YESIMBOT_BIND=$2 ;;
        --port) YESIMBOT_PORT=$2 ;;
        --public-origin) ADMIN_PUBLIC_ORIGIN=$2 ;;
      esac
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { echo 'This installer supports Linux only.' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'The pinned NapCat image supports Linux amd64 only.' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Install Docker Engine and the Compose v2 plugin first.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Docker daemon is unavailable or your user lacks access.' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'Install the Docker Compose v2 plugin first.' >&2; exit 1; }
if ((CHECK_ONLY)); then echo 'Docker and Compose are available (Linux amd64).'; exit 0; fi
YESIMBOT_DATA_DIR=${YESIMBOT_DATA_DIR:-$ROOT/.yesimbot-data}
YESIMBOT_BIND=${YESIMBOT_BIND:-127.0.0.1}
YESIMBOT_PORT=${YESIMBOT_PORT:-5140}
ADMIN_PUBLIC_ORIGIN=${ADMIN_PUBLIC_ORIGIN:-}
if [[ -n $ADMIN_PUBLIC_ORIGIN ]]; then
  [[ $ADMIN_PUBLIC_ORIGIN =~ ^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$ && $ADMIN_PUBLIC_ORIGIN != *..* ]] || { echo 'Public origin must be an exact http(s)://hostname[:port] origin without credentials, path or query.' >&2; exit 1; }
  origin_port=${ADMIN_PUBLIC_ORIGIN##*:}
  if [[ $origin_port =~ ^[0-9]+$ ]]; then
    ((10#$origin_port > 0 && 10#$origin_port < 65536)) && [[ $origin_port != 0* ]] || { echo 'Invalid public origin port.' >&2; exit 1; }
    [[ $ADMIN_PUBLIC_ORIGIN != http://*:80 && $ADMIN_PUBLIC_ORIGIN != https://*:443 ]] || { echo 'Omit the default port from public origin.' >&2; exit 1; }
  fi
fi
[[ $YESIMBOT_DATA_DIR =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Data directory must be an absolute path without spaces or special characters.' >&2; exit 1; }
[[ $YESIMBOT_BIND =~ ^[a-zA-Z0-9.:_-]+$ ]] || { echo 'Invalid bind address.' >&2; exit 1; }
[[ $YESIMBOT_PORT =~ ^[0-9]+$ ]] && ((10#$YESIMBOT_PORT > 0 && 10#$YESIMBOT_PORT < 65536)) || { echo 'Invalid port.' >&2; exit 1; }
mkdir -p "$YESIMBOT_DATA_DIR"/{koishi,qq,napcat-config,napcat-plugins}
# Keep credential parent directories traversable by the installer owner on reruns.
mkdir -p "$YESIMBOT_DATA_DIR/koishi/data/console-admin"
SECRET="$YESIMBOT_DATA_DIR/admin-password"
if [[ ! -f "$YESIMBOT_DATA_DIR/koishi/data/console-admin/credential.json" && ! -s "$SECRET" ]]; then
  if [[ -n $PASSWORD_FILE ]]; then
    [[ -f $PASSWORD_FILE && $(stat -c %u "$PASSWORD_FILE") == $(id -u) && $(stat -c %a "$PASSWORD_FILE") =~ ^(400|600)$ ]] || { echo 'Password file must be owned by you with mode 400 or 600.' >&2; exit 1; }
    PASSWORD=$(cat -- "$PASSWORD_FILE")
  else
    [[ -t 0 ]] || { echo 'Use --password-file for noninteractive installation.' >&2; exit 1; }
    read -r -s -p 'Initial admin password (12+ characters): ' PASSWORD; echo
    read -r -s -p 'Confirm password: ' CONFIRM; echo
    [[ $PASSWORD == "$CONFIRM" ]] || { echo 'Passwords differ.' >&2; exit 1; }
    unset CONFIRM
  fi
  [[ ${#PASSWORD} -ge 12 && ${#PASSWORD} -le 4096 && $PASSWORD != *$'\n'* && $PASSWORD != *$'\r'* ]] || { echo 'Use a single-line password with 12 to 4096 characters.' >&2; exit 1; }
  printf '%s' "$PASSWORD" > "$SECRET"
  unset PASSWORD
fi
[[ -f $SECRET ]] || : > "$SECRET"
chmod 600 "$SECRET"
printf 'YESIMBOT_DATA_DIR=%s\nYESIMBOT_BIND=%s\nYESIMBOT_PORT=%s\nADMIN_PUBLIC_ORIGIN=%s\n' "$YESIMBOT_DATA_DIR" "$YESIMBOT_BIND" "$YESIMBOT_PORT" "$ADMIN_PUBLIC_ORIGIN" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
cd "$ROOT"
docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.yaml" up -d --build --wait --wait-timeout 240
# Initialization succeeded; retain an empty secret mount for future recreations.
: > "$SECRET"
printf 'Ready: http://%s:%s (administrator: admin)\n' "$YESIMBOT_BIND" "$YESIMBOT_PORT"
echo 'For the default loopback binding, connect through an SSH tunnel, for example: ssh -L 5140:127.0.0.1:5140 <server>.'
