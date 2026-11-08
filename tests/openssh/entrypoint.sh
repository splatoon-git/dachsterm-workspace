#!/bin/sh
set -eu
umask 077
mkdir -p /run/probe /home/probe/.ssh
openssl rand -hex 32 > /run/probe/password
openssl rand -hex 32 > /run/probe/passphrase
printf 'probe:%s\n' "$(cat /run/probe/password)" | chpasswd
ssh-keygen -q -t ed25519 -N '' -f /run/probe/host
ssh-keygen -q -t rsa -b 3072 -N '' -f /run/probe/host_rsa
ssh-keygen -q -t ed25519 -N '' -f /run/probe/plain
ssh-keygen -q -t rsa -b 3072 -N '' -f /run/probe/rsa
cp /run/probe/rsa /run/probe/rsa_encrypted
ssh-keygen -q -p -P '' -N "$(cat /run/probe/passphrase)" -f /run/probe/rsa_encrypted >/dev/null
cp /run/probe/rsa /run/probe/rsa_pem
ssh-keygen -q -p -P '' -N '' -m PEM -f /run/probe/rsa_pem >/dev/null
openssl pkcs8 -topk8 -in /run/probe/rsa_pem -out /run/probe/rsa_pkcs8 -passout file:/run/probe/passphrase
ssh-keygen -q -t ed25519 -N "$(cat /run/probe/passphrase)" -f /run/probe/encrypted
cat /run/probe/plain.pub /run/probe/encrypted.pub /run/probe/rsa.pub > /home/probe/.ssh/authorized_keys
chown -R probe:probe /home/probe/.ssh
printf '\nexport LANG=C.UTF-8\nexport LC_ALL=C.UTF-8\n' >> /home/probe/.bashrc
python3 /echo.py &
# HTTPS Git credentials (DX.12): a private runtime folder like pam_systemd's, where a cache daemon
# could start, and a socket owned by root at a helper-style path, which the helper must not use.
uid=$(id -u probe)
install -d -m 700 -o probe -g probe "/run/user/$uid"
printf '\nSetEnv XDG_RUNTIME_DIR=/run/user/%s\n' "$uid" >> /etc/ssh/sshd_config
install -m 644 /dev/null /tmp/dx-rootsock.log
python3 -c 'import os, socket
p = "/tmp/dachsterm-git-rootowned"
s = socket.socket(socket.AF_UNIX)
s.bind(p)
os.chmod(p, 0o777)
s.listen(4)
while True:
    c, _ = s.accept()
    open("/tmp/dx-rootsock.log", "a").write("connected\n")
    c.close()' &
ssh-agent -a /run/probe/agent.sock >/dev/null
SSH_AUTH_SOCK=/run/probe/agent.sock ssh-add /run/probe/rsa 2>/dev/null
socat TCP-LISTEN:2222,reuseaddr,fork UNIX-CONNECT:/run/probe/agent.sock &
# Separate real key + PAM keyboard-interactive server, with only an RSA host key. It also refuses
# agent and socket forwarding, so both refusals are checked against real OpenSSH.
sed -e 's/^Port 22/Port 2223/' -e 's/^AllowAgentForwarding yes/AllowAgentForwarding no/' -e '\|^HostKey /run/probe/host$|d' -e 's/^UsePAM no/UsePAM yes/' -e 's/^KbdInteractiveAuthentication no/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config > /run/probe/mfa_config
printf '\nAuthenticationMethods publickey,keyboard-interactive\nPubkeyAcceptedAlgorithms rsa-sha2-256\nAllowStreamLocalForwarding no\n' >> /run/probe/mfa_config
/usr/sbin/sshd -f /run/probe/mfa_config -E /run/probe/mfa.log
touch /run/probe/ready
exec /usr/sbin/sshd -D -e
