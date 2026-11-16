#!/bin/sh
# Writes every throwaway secret of the connect fixture into /run/fixture (a volume shared by all
# containers). Nothing here is reused outside the fixture; `down` deletes the volume.
set -eu
umask 077
out=/run/fixture
if [ -f "$out/ready" ]; then exit 0; fi
for name in user proxy; do openssl rand -hex 16 > "$out/$name.password"; done
openssl rand -hex 16 > "$out/x11.cookie"
for role in target jump; do ssh-keygen -q -t ed25519 -N '' -C "$role" -f "$out/host_$role"; done
ssh-keygen -q -t ed25519 -N '' -C fixture-ca -f "$out/ca"
# plain: in authorized_keys. The cert_* keys are not, so only their certificate can log in.
ssh-keygen -q -t ed25519 -N '' -f "$out/plain"
ssh-keygen -q -t ed25519 -N '' -f "$out/cert_ed25519"
ssh-keygen -q -t rsa -b 3072 -N '' -f "$out/cert_rsa"
ssh-keygen -q -t ed25519 -N '' -f "$out/cert_expired"
ssh-keygen -q -t ed25519 -N '' -f "$out/cert_other"
ssh-keygen -q -s "$out/ca" -I fixture-ed25519 -n probe -V -5m:+1d "$out/cert_ed25519.pub"
ssh-keygen -q -s "$out/ca" -I fixture-rsa -n probe -V -5m:+1d "$out/cert_rsa.pub"
ssh-keygen -q -s "$out/ca" -I fixture-expired -n probe -V -2d:-1d "$out/cert_expired.pub"
ssh-keygen -q -s "$out/ca" -I fixture-other -n someone-else -V -5m:+1d "$out/cert_other.pub"
chmod 644 "$out"/*.pub
touch "$out/ready"
