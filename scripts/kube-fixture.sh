#!/usr/bin/env bash
# Reusable Kubernetes check environment (KV.1 and later): a kind cluster and the tests/openssh
# server on kind's network, so the server can reach the API server the way a jump host does.
#
# Run from Windows with: npm run kube:fixture -- <cluster> [up|down|status]
# Run inside WSL Ubuntu-24.04 from the repository: bash scripts/kube-fixture.sh <cluster> [...]
#
# It creates or deletes only the cluster and container named after <cluster>. Passwords stay in
# the container's /run/probe; this script never prints them.
set -euo pipefail

cluster=${1:-}
action=${2:-up}
if [[ ! $cluster =~ ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$ ]]; then
  echo "usage: kube-fixture.sh <cluster-name> [up|down|status|metrics-on|metrics-off|ingress-up|ingress-metrics-on|ingress-metrics-off]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
node_image=kindest/node@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5
ssh_image=dachsterm-kube-ssh
ssh_container="$cluster-ssh"

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$cluster"; }
ssh_exists() { docker ps -a --format '{{.Names}}' | grep -qx "$ssh_container"; }
in_ssh() { docker exec -i "$ssh_container" sh -c "$1"; }

status() {
  echo "CLUSTER=$cluster"
  echo "SSH_CONTAINER=$ssh_container"
  local mapping
  mapping=$(docker port "$ssh_container" 22/tcp | head -1)
  echo "SSH_PORT=${mapping##*:}"
  echo "SSH_USER=probe"
  echo "RKE_USER=rkeuser"
}

down() {
  if ssh_exists; then docker rm -f "$ssh_container" >/dev/null; fi
  if cluster_exists; then kind delete cluster --name "$cluster"; fi
}

# ~/.bashrc (interactive only): kubectl and KUBECONFIG exist nowhere else for this account.
prepare_bashrc_account() {
  local config=/opt/kube/config
  # Two contexts, so choosing one is a real choice.
  kind get kubeconfig --internal --name "$cluster" | in_ssh "cat > $config"
  in_ssh "
    /opt/kube/bin/kubectl --kubeconfig $config config set-context second \
      --cluster=kind-$cluster --user=kind-$cluster --namespace=dachsterm-check
    chown probe:probe $config
    chmod 600 $config
    grep -q KUBECONFIG /home/probe/.bashrc || cat >> /home/probe/.bashrc <<'RC'
export PATH=/opt/kube/bin:\$PATH
export KUBECONFIG=/opt/kube/config
RC
  "
}

# A kubeconfig only root can read, and kubectl where RKE2 puts it. Not a real RKE2 install.
prepare_root_only_account() {
  in_ssh '
    id rkeuser >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo rkeuser
    mkdir -p /etc/rancher/rke2 /var/lib/rancher/rke2/bin
    cp /opt/kube/bin/kubectl /var/lib/rancher/rke2/bin/kubectl
    umask 077
    [ -s /run/probe/rke_password ] || openssl rand -hex 32 > /run/probe/rke_password
    printf "rkeuser:%s\n" "$(cat /run/probe/rke_password)" | chpasswd
    chown root:root /run/probe/rke_password
  '
  kind get kubeconfig --internal --name "$cluster" | in_ssh 'cat > /etc/rancher/rke2/rke2.yaml'
  in_ssh '
    chown root:root /etc/rancher/rke2/rke2.yaml
    chmod 600 /etc/rancher/rke2/rke2.yaml
    grep -q "^AllowUsers probe rkeuser" /etc/ssh/sshd_config ||
      sed -i "s/^AllowUsers probe.*/AllowUsers probe rkeuser/" /etc/ssh/sshd_config
    kill -HUP 1
  '
}

up() {
  if ! cluster_exists; then
    kind create cluster --name "$cluster" --image "$node_image" --wait 180s \
      --kubeconfig "/tmp/dachsterm-$cluster.config"
  fi
  if ! ssh_exists; then
    docker build -q -t dachsterm-openssh-probe tests/openssh >/dev/null
    docker build -q -t "$ssh_image" - >/dev/null <<'DOCKERFILE'
FROM dachsterm-openssh-probe
RUN apt-get update && apt-get install -y --no-install-recommends sudo && rm -rf /var/lib/apt/lists/*
DOCKERFILE
    docker run -d --rm --name "$ssh_container" --network kind \
      --label app.dachsterm.purpose=kube-fixture \
      -p 127.0.0.1::22 \
      --tmpfs /run/probe:rw,noexec,nosuid,mode=0700 \
      "$ssh_image" >/dev/null
    for _ in $(seq 1 60); do
      in_ssh 'test -f /run/probe/ready' 2>/dev/null && break
      sleep 1
    done
    in_ssh 'test -f /run/probe/ready'
  fi
  if ! in_ssh 'test -x /opt/kube/bin/kubectl'; then
    # Streamed: WSL's kubectl is often a symlink into Docker Desktop's folder, which `docker cp` trips on.
    in_ssh 'rm -f /tmp/kubectl; cat > /tmp/kubectl' < "$(readlink -f "$(command -v kubectl)")"
    in_ssh 'install -D -m 755 /tmp/kubectl /opt/kube/bin/kubectl && rm /tmp/kubectl'
  fi
  prepare_bashrc_account
  prepare_root_only_account
  # The server really reaches the cluster: the same path a jump host would use.
  in_ssh "/opt/kube/bin/kubectl --kubeconfig /opt/kube/config get nodes -o name" >/dev/null
  status
}

metrics_url=https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
kubectl_in_ssh() { in_ssh "/opt/kube/bin/kubectl --kubeconfig /opt/kube/config $1"; }

# kind's kubelets have self-signed certificates, so metrics-server needs the insecure flag here.
metrics_on() {
  curl -fsSL "$metrics_url" | in_ssh '/opt/kube/bin/kubectl --kubeconfig /opt/kube/config apply -f -' >/dev/null
  kubectl_in_ssh "-n kube-system patch deployment metrics-server --type=json \
    -p='[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/args/-\",\"value\":\"--kubelet-insecure-tls\"}]'" >/dev/null
  kubectl_in_ssh '-n kube-system rollout status deployment/metrics-server --timeout=180s' >/dev/null
  status
}

metrics_off() {
  curl -fsSL "$metrics_url" | in_ssh '/opt/kube/bin/kubectl --kubeconfig /opt/kube/config delete --ignore-not-found -f -' >/dev/null
  status
}

ingress_url=https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/kind/deploy.yaml

# This manifest ships with the controller's metrics off, and schedules it on a node labelled so.
ingress_up() {
  kubectl_in_ssh 'label nodes --all ingress-ready=true --overwrite' >/dev/null
  curl -fsSL "$ingress_url" | in_ssh '/opt/kube/bin/kubectl --kubeconfig /opt/kube/config apply -f -' >/dev/null
  kubectl_in_ssh '-n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s' >/dev/null
  status
}

# metrics-on and metrics-off above are metrics-server. This is the controller's own flag.
ingress_metrics() {
  local value=$1 args at op path
  args=$(kubectl_in_ssh "-n ingress-nginx get deployment ingress-nginx-controller \
    -o go-template='{{range (index .spec.template.spec.containers 0).args}}{{println .}}{{end}}'")
  at=$(printf '%s\n' "$args" | grep -n '^--enable-metrics=' | cut -d: -f1 || true)
  if [ -n "$at" ]; then
    op=replace path=$((at - 1))
  else
    op=add path=-
  fi
  kubectl_in_ssh "-n ingress-nginx patch deployment ingress-nginx-controller --type=json \
    -p='[{\"op\":\"$op\",\"path\":\"/spec/template/spec/containers/0/args/$path\",\"value\":\"--enable-metrics=$value\"}]'" >/dev/null
  kubectl_in_ssh '-n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s' >/dev/null
  status
}

case $action in
  up) up ;;
  down) down ;;
  status) status ;;
  metrics-on) metrics_on ;;
  metrics-off) metrics_off ;;
  ingress-up) ingress_up ;;
  ingress-metrics-on) ingress_metrics true ;;
  ingress-metrics-off) ingress_metrics false ;;
  *)
    echo "unknown action: $action" >&2
    exit 2
    ;;
esac
