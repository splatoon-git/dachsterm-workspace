#!/usr/bin/env bash
# Run in the Ubuntu WSL distribution; creates only the named isolated fixture.
set -euo pipefail
cd "$(dirname "$0")/.."
kind create cluster --name dachsterm-podtree-check --image kindest/node@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5 --kubeconfig /tmp/dachsterm-podtree-check.config --wait 120s
export KUBECONFIG=/tmp/dachsterm-podtree-check.config
kind load docker-image busybox:1.37.0 --name dachsterm-podtree-check
kubectl create namespace dachsterm-check
kubectl create namespace dachsterm-empty
kubectl run log-demo -n dachsterm-check --image=busybox:1.37.0 --image-pull-policy=Never --restart=Never -- sh -c 'while true; do echo DACHSTERM_POD_LOG; sleep 1; done'
kubectl wait -n dachsterm-check --for=condition=Ready pod/log-demo --timeout=60s
bash tests/podtree-rbac.sh
