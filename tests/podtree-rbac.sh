#!/usr/bin/env bash
set -euo pipefail
export KUBECONFIG=/tmp/daxterm-podtree-check.config
kubectl apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: viewer
  namespace: daxterm-check
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: viewer
  namespace: daxterm-check
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log", "events"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: viewer
  namespace: daxterm-check
subjects:
- kind: ServiceAccount
  name: viewer
  namespace: daxterm-check
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: viewer
YAML
token=$(kubectl create token viewer -n daxterm-check --duration=1h)
kubectl config set-credentials daxterm-viewer --token="$token" >/dev/null
unset token
kubectl config set-context daxterm-viewer --cluster=kind-daxterm-podtree-check --user=daxterm-viewer --namespace=daxterm-check >/dev/null
chmod 600 "$KUBECONFIG"
test "$(kubectl --context=daxterm-viewer auth can-i get pods -n daxterm-check)" = yes
test "$(kubectl --context=daxterm-viewer auth can-i create pods/exec -n daxterm-check)" = no
test "$(kubectl --context=daxterm-viewer auth can-i delete pods -n daxterm-check)" = no
test "$(kubectl --context=daxterm-viewer auth can-i list namespaces)" = no
kubectl --context=daxterm-viewer get pods -n daxterm-check -o name
