#!/bin/sh
set -eu
secrets=/run/fixture
user_password=$(cat "$secrets/user.password")
proxy_password=$(cat "$secrets/proxy.password")
printf 'probe:%s\n' "$user_password" | chpasswd
printf '\nexport LANG=C.UTF-8\n' >> /home/probe/.bashrc

# HTTP CONNECT (CG.1). CONNECT is allowed to port 22 only, so a refused port is checkable.
cat > /etc/tinyproxy/tinyproxy.conf <<EOF
User tinyproxy
Group tinyproxy
Port 3128
Listen 0.0.0.0
Timeout 600
MaxClients 50
BasicAuth probe $proxy_password
ConnectPort 22
LogLevel Info
LogFile "/var/log/tinyproxy/tinyproxy.log"
EOF
install -d -o tinyproxy -g tinyproxy /var/log/tinyproxy /run/tinyproxy
tinyproxy -c /etc/tinyproxy/tinyproxy.conf

# SOCKS5 with username/password only (CG.1). Names are resolved here, not on the host.
microsocks -i 0.0.0.0 -p 1080 -u probe -P "$proxy_password" >/dev/null 2>&1 &

# Telnet (CG.4): inetd starts telnetd with the standard login.
echo 'telnet stream tcp nowait root /usr/sbin/telnetd telnetd' > /etc/inetd.conf
/usr/sbin/inetd /etc/inetd.conf

# External X server (CG.9) on TCP 6000, display :0, cookie authentication.
xauth -f /root/.Xauthority add :0 MIT-MAGIC-COOKIE-1 "$(cat "$secrets/x11.cookie")"
Xvfb :0 -listen tcp -nolisten unix -auth /root/.Xauthority -screen 0 800x600x24 >/dev/null 2>&1 &

# Serial console stand-in (CG.5): an echoing shell on a PTY behind TCP 7000.
socat TCP-LISTEN:7000,reuseaddr,fork \
  EXEC:"env PS1='device> ' /bin/bash --noprofile --norc -i",pty,stderr,setsid,sigint,sane,ctty &

touch /run/edge-ready
wait
