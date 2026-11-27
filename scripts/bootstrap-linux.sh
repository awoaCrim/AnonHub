#!/usr/bin/env bash
# Download a source checkout; installation secrets are read by install-linux.sh.
set -euo pipefail
umask 077
REPO=${YESIMBOT_SOURCE_REPO:-awoaCrim/AnonHub}
REF=${YESIMBOT_SOURCE_REF:-main}
INSTALL_DIR=${YESIMBOT_INSTALL_DIR:-$PWD/yesimbot-single}
[[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $REPO != *..* ]] || { echo 'Invalid source repository (use owner/repository).' >&2; exit 1; }
[[ $REF =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $REF != *..* && $REF != */ && $REF != *//* ]] || { echo 'Invalid source ref.' >&2; exit 1; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'This bootstrap supports Linux amd64 only.' >&2; exit 1; }
command -v docker >/dev/null && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || { echo 'Install Docker Engine and Compose v2, and ensure Docker is accessible first.' >&2; exit 1; }
command -v curl >/dev/null && command -v tar >/dev/null || { echo 'curl and tar are required.' >&2; exit 1; }
[[ $INSTALL_DIR == /* ]] || INSTALL_DIR="$PWD/$INSTALL_DIR"
INSTALL_DIR=${INSTALL_DIR%/}
[[ $INSTALL_DIR =~ ^/[A-Za-z0-9_./-]+$ && $INSTALL_DIR != / && $INSTALL_DIR != */../* && $INSTALL_DIR != */.. && $INSTALL_DIR != */./* && $INSTALL_DIR != */. && $INSTALL_DIR != *//* ]] || { echo 'Use a safe install directory without spaces or parent traversal.' >&2; exit 1; }
ancestor=$INSTALL_DIR
while [[ $ancestor != / ]]; do
  [[ ! -L $ancestor ]] || { echo 'Install path must not contain symbolic links.' >&2; exit 1; }
  ancestor=$(dirname -- "$ancestor")
done
MARKER="$INSTALL_DIR/.yesimbot-source"
if [[ -d $INSTALL_DIR && -n $(ls -A -- "$INSTALL_DIR") ]]; then
  [[ -f $MARKER && ! -L $MARKER && $(cat -- "$MARKER") == "$REPO@$REF" && -f $INSTALL_DIR/scripts/install-linux.sh ]] || { echo 'Refusing to overwrite a non-empty directory without a matching installation marker.' >&2; exit 1; }
  echo 'Reusing existing source installation; source updates are manual.'
else
  parent=$(dirname -- "$INSTALL_DIR")
  mkdir -p -- "$parent"
  staging=$(mktemp -d "$parent/.yesimbot-bootstrap.XXXXXX")
  trap 'rm -rf -- "$staging"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://codeload.github.com/$REPO/tar.gz/$REF" --output "$staging/source.tar.gz"
  # GitHub archives contain one root directory. Reject paths/links that could escape extraction.
  tar -tzf "$staging/source.tar.gz" > "$staging/entries"
  archive_root=''
  while IFS= read -r entry; do
    entry_root=${entry%%/*}
    [[ -z $archive_root ]] && archive_root=$entry_root
    [[ $entry_root == "$archive_root" ]] || { echo 'Source archive has multiple roots.' >&2; exit 1; }
    [[ $entry != /* && $entry != *../* && $entry != *'/..' && $entry == */* ]] || { echo 'Unsafe source archive path.' >&2; exit 1; }
  done < "$staging/entries"
  if tar -tvzf "$staging/source.tar.gz" | LC_ALL=C awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" { found=1 } END { exit !found }'; then
    echo 'Source archive links and special files are not accepted.' >&2; exit 1
  fi
  mkdir "$staging/source"
  tar -xzf "$staging/source.tar.gz" --strip-components=1 -C "$staging/source" --no-same-owner --no-same-permissions
  [[ -f $staging/source/scripts/install-linux.sh && -f $staging/source/compose.yaml && -f $staging/source/package.json ]] || { echo 'Archive is missing the distribution installer.' >&2; exit 1; }
  printf '%s@%s\n' "$REPO" "$REF" > "$staging/source/.yesimbot-source"
  if [[ -d $INSTALL_DIR ]]; then rmdir -- "$INSTALL_DIR"; fi
  mv -- "$staging/source" "$INSTALL_DIR"
  rm -rf -- "$staging"
  trap - EXIT
fi
# curl | bash consumes stdin; reconnect to the controlling terminal for prompts.
if [[ ! -t 0 ]]; then
  if (: </dev/tty) 2>/dev/null; then
    exec bash "$INSTALL_DIR/scripts/install-linux.sh" "$@" </dev/tty
  elif [[ $# == 0 ]]; then
    echo 'Interactive installation needs /dev/tty; pass --password-file for unattended use.' >&2
    exit 1
  fi
fi
exec bash "$INSTALL_DIR/scripts/install-linux.sh" "$@"
