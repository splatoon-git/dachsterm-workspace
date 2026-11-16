#!/bin/sh
# ROLE=init writes the secrets and exits; ROLE=target|jump runs sshd with that role's host key.
set -eu
if [ "$ROLE" = init ]; then exec sh /init.sh; fi
umask 077
printf 'probe:%s\n' "$(cat /run/fixture/user.password)" | chpasswd
install -d -m 700 -o probe -g probe /home/probe/.ssh
install -m 600 -o probe -g probe /run/fixture/plain.pub /home/probe/.ssh/authorized_keys
printf '\nexport LANG=C.UTF-8\nexport LC_ALL=C.UTF-8\n' >> /home/probe/.bashrc
# A file to send back with sz/tsz (CG.8).
head -c 65536 /dev/urandom > /home/probe/sample.bin
chown probe:probe /home/probe/sample.bin
exec /usr/sbin/sshd -D -e -h "/run/fixture/host_$ROLE"
