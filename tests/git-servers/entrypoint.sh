#!/bin/sh
# A random password for `probe`, fresh host keys, then sshd with password login only.
set -eu
umask 077
mkdir -p /run/probe
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > /run/probe/password
printf 'probe:%s\n' "$(cat /run/probe/password)" | chpasswd
ssh-keygen -A >/dev/null
cat > /run/probe/sshd_config <<'EOF'
Port 22
PasswordAuthentication yes
PubkeyAuthentication no
PermitRootLogin no
AllowUsers probe
UsePAM no
# CentOS 7 looks the client up in DNS by default, which stalls the login in a container.
UseDNS no
PrintMotd no
LogLevel ERROR
EOF
touch /run/probe/ready
exec /usr/sbin/sshd -D -e -f /run/probe/sshd_config
