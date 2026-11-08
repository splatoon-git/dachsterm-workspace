#!/bin/sh
# Makes a self-signed certificate and the user `probe` with a random password, then serves HTTPS.
set -eu
umask 077
/usr/local/bin/docker-setup.sh
mkdir -p /var/lib/gitea/probe
cd /var/lib/gitea/probe
gitea cert --host git.test >/dev/null 2>&1
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > password
gitea -c "$GITEA_APP_INI" migrate >/dev/null 2>&1
gitea -c "$GITEA_APP_INI" admin user create --username probe --password "$(cat password)" \
  --email probe@git.test --must-change-password=false >/dev/null
exec gitea -c "$GITEA_APP_INI" web
