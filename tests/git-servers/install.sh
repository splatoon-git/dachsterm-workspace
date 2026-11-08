#!/bin/sh
# Installs sshd, git, tmux, procps and git-lfs where the distribution has it, and the user `probe`
# with Bash as login shell, so the app's shell hook applies as on a usual server.
set -eu
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends openssh-server git git-lfs tmux procps ca-certificates
  rm -rf /var/lib/apt/lists/*
  mkdir -p /run/sshd
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache openssh-server git git-lfs tmux procps bash
elif command -v yum >/dev/null 2>&1; then
  # CentOS 7 is past its end of life; its packages are only on the vault mirror.
  sed -i -e 's/^mirrorlist=/#mirrorlist=/' \
    -e 's|^#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' \
    /etc/yum.repos.d/CentOS-*.repo
  yum install -y openssh-server git tmux procps-ng
  yum clean all
fi
if command -v useradd >/dev/null 2>&1; then
  useradd -m -s /bin/bash probe
else
  adduser -D -s /bin/bash probe
fi
