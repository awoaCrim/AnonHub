#!/bin/bash
set -euo pipefail

# An explicit QQ logout must also survive a later container restart.
if [[ -e "${NAPCAT_CONFIG_DIR:-/app/napcat/config}/yesimbot-logged-out" ]]; then
  export ACCOUNT=""
  unset NAPCAT_QUICK_ACCOUNT NAPCAT_QUICK_PASSWORD NAPCAT_QUICK_PASSWORD_MD5
fi

exec /bin/bash /app/entrypoint.sh
