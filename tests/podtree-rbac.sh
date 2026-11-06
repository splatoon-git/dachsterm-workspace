#!/usr/bin/env bash
set -euo pipefail
export KUBECONFIG=/tmp/dachsterm-podtree-check.config
kubectl apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: viewer
  namespace: dachsterm-check
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: viewer
  namespace: dachsterm-check
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log", "events"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: viewer
  namespace: dachsterm-check
subjects:
- kind: ServiceAccount
  name: viewer
  namespace: dachsterm-check
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: viewer
YAML
token=$(kubectl create token viewer -n dachsterm-check --duration=1h)
kubectl config set-credentials dachsterm-viewer --token="$token" >/dev/null
unset token
kubectl config set-context dachsterm-viewer --cluster=kind-dachsterm-podtree-check --user=dachsterm-viewer --namespace=dachsterm-check >/dev/null
chmod 600 "$KUBECONFIG"
test "$(kubectl --context=dachsterm-viewer auth can-i get pods -n dachsterm-check)" = yes
test "$(kubectl --context=dachsterm-viewer auth can-i create pods/exec -n dachsterm-check)" = no
test "$(kubectl --context=dachsterm-viewer auth can-i delete pods -n dachsterm-check)" = no
test "$(kubectl --context=dachsterm-viewer auth can-i list namespaces)" = no
kubectl --context=dachsterm-viewer get pods -n dachsterm-check -o name
