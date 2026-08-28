#!/usr/bin/env bash
# test-pipeline.sh
#
# Smoke-test the abc-node systemd variant after cloud-init completes.
#
# Run from the host (macOS) inside the Pulumi project:
#   bash scripts/test-pipeline.sh
#
# Or pass the IP directly:
#   VM_IP=192.168.64.5 bash scripts/test-pipeline.sh
#
# What is tested:
#   1. systemd service health (minio, minio-init, tusd, nomad; caddy if HTTPS)
#   2. Nomad job health (fx-tusd-hook — via job status + HTTP healthz at :14002)
#   3. MinIO health (HTTP :9000, or HTTPS :9443 when enableHttps=true)
#   4. tusd endpoint reachability (:1080 HTTP or :1443 HTTPS)
#   5. TUS upload (POST + PATCH)
#   6. Nomad API (:4646)
#   7. abc job run hello-cluster (if abc CLI present)
#
# HTTPS detection: reads `pulumi stack output httpsEnabled`. Override with:
#   HTTPS_MODE=true bash scripts/test-pipeline.sh

set -euo pipefail

VM_IP="${VM_IP:-}"
if [[ -z "$VM_IP" ]]; then
  VM_IP=$(pulumi stack output ipv4 2>/dev/null || true)
fi
if [[ -z "$VM_IP" ]]; then
  echo "ERROR: set VM_IP or run inside the Pulumi project (pulumi stack output ipv4)" >&2
  exit 1
fi

# Detect HTTPS mode from Pulumi stack output (or env override).
HTTPS_MODE="${HTTPS_MODE:-}"
if [[ -z "$HTTPS_MODE" ]]; then
  HTTPS_MODE=$(pulumi stack output httpsEnabled 2>/dev/null || echo "false")
fi

ok()   { echo "  ✓ $*"; }
warn() { echo "  ! $*"; }
fail() { echo "  ✗ $*"; FAILED=$((FAILED+1)); }
FAILED=0

echo "==> abc-node systemd smoke test  VM=${VM_IP}  httpsEnabled=${HTTPS_MODE}"
echo ""

# ── 1. systemd service health ─────────────────────────────────────────────────
# NOTE: fx-tusd-hook is a Nomad job (not a systemd unit) — checked in step 2.
echo "── systemd services ──────────────────────────────────────────────────────"
SERVICES=(minio minio-init tusd nomad)
if [[ "$HTTPS_MODE" == "true" ]]; then
  SERVICES+=(caddy)
fi
for svc in "${SERVICES[@]}"; do
  STATE=$(multipass exec abc-node -- systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  if [[ "$STATE" == "active" ]]; then
    ok "${svc}: active"
  else
    fail "${svc}: ${STATE}"
  fi
done
echo ""

# ── 2. Nomad job: fx-tusd-hook ────────────────────────────────────────────────
echo "── Nomad job: fx-tusd-hook ───────────────────────────────────────────────"
JOB_STATUS=$(multipass exec abc-node -- \
  bash -c 'NOMAD_ADDR=http://127.0.0.1:4646 nomad job status fx-tusd-hook 2>/dev/null | awk "/^Status/{print \$3}"' \
  2>/dev/null || echo "unknown")
if [[ "$JOB_STATUS" == "running" ]]; then
  ok "Nomad job fx-tusd-hook: running"
else
  fail "Nomad job fx-tusd-hook: ${JOB_STATUS:-not found}"
fi

HOOK_HEALTH=$(curl -sS -o /dev/null -w "%{http_code}" \
  --max-time 10 "http://${VM_IP}:14002/healthz" 2>/dev/null || echo "ERR")
if [[ "$HOOK_HEALTH" =~ ^2 ]]; then
  ok "fx-tusd-hook /healthz → HTTP ${HOOK_HEALTH}"
else
  fail "fx-tusd-hook /healthz → ${HOOK_HEALTH}"
fi
echo ""

# ── 3. MinIO health ───────────────────────────────────────────────────────────
if [[ "$HTTPS_MODE" == "true" ]]; then
  echo "── MinIO S3 HTTPS (https://${VM_IP}:9443) ────────────────────────────────"
  MINIO_HEALTH=$(curl -ksS -o /dev/null -w "%{http_code}" \
    --max-time 10 "https://${VM_IP}:9443/minio/health/live" 2>/dev/null || echo "ERR")
else
  echo "── MinIO S3 HTTP (http://${VM_IP}:9000) ──────────────────────────────────"
  MINIO_HEALTH=$(curl -sS -o /dev/null -w "%{http_code}" \
    --max-time 10 "http://${VM_IP}:9000/minio/health/live" 2>/dev/null || echo "ERR")
fi
if [[ "$MINIO_HEALTH" =~ ^2 ]]; then
  ok "MinIO /minio/health/live → HTTP ${MINIO_HEALTH}"
else
  fail "MinIO health check → ${MINIO_HEALTH}"
fi
echo ""

# ── 4 + 5. tusd reachability + TUS upload ────────────────────────────────────
if [[ "$HTTPS_MODE" == "true" ]]; then
  TUSD_URL="https://${VM_IP}:1443/files/"
  CURL_OPTS="-ksS"
  echo "── tusd HTTPS (${TUSD_URL}) ──────────────────────────────────────────────"
else
  TUSD_URL="http://${VM_IP}:1080/files/"
  CURL_OPTS="-sS"
  echo "── tusd HTTP (${TUSD_URL}) ────────────────────────────────────────────────"
fi

TUSD_HEALTH=$(curl ${CURL_OPTS} -o /dev/null -w "%{http_code}" \
  --max-time 10 "${TUSD_URL}" 2>/dev/null || echo "ERR")
# tusd returns 405 on GET /files/ — that still means it's up
if [[ "$TUSD_HEALTH" =~ ^(2|4) ]]; then
  ok "tusd reachable → HTTP ${TUSD_HEALTH}"
else
  fail "tusd → ${TUSD_HEALTH}"
fi

PAYLOAD="Hello from abc-node systemd smoke test"
PAYLOAD_LEN=${#PAYLOAD}
FILENAME="abc-node-smoke-test.txt"

UPLOAD_RESP=$(curl ${CURL_OPTS} -D - -o /dev/null \
  --max-time 15 \
  -X POST "${TUSD_URL}" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: ${PAYLOAD_LEN}" \
  -H "Upload-Metadata: filename $(echo -n "${FILENAME}" | base64)" \
  2>/dev/null || true)

UPLOAD_LOC=$(echo "$UPLOAD_RESP" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
if [[ -z "$UPLOAD_LOC" ]]; then
  fail "TUS POST: no Location header — tusd may not have the tusd bucket yet"
else
  ok "TUS POST → location: ${UPLOAD_LOC}"
  PATCH_STATUS=$(curl ${CURL_OPTS} -o /dev/null -w "%{http_code}" \
    --max-time 15 \
    -X PATCH "${UPLOAD_LOC}" \
    -H "Tus-Resumable: 1.0.0" \
    -H "Content-Type: application/offset+octet-stream" \
    -H "Upload-Offset: 0" \
    -d "${PAYLOAD}" 2>/dev/null || echo "ERR")
  if [[ "$PATCH_STATUS" =~ ^2 ]]; then
    ok "TUS PATCH → HTTP ${PATCH_STATUS} (upload complete)"
  else
    fail "TUS PATCH → ${PATCH_STATUS}"
  fi
fi
echo ""

# ── 6. Nomad API ──────────────────────────────────────────────────────────────
echo "── Nomad API (http://${VM_IP}:4646) ──────────────────────────────────────"
NOMAD_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  --max-time 10 "http://${VM_IP}:4646/v1/status/leader" 2>/dev/null || echo "ERR")
if [[ "$NOMAD_STATUS" =~ ^2 ]]; then
  ok "Nomad /v1/status/leader → HTTP ${NOMAD_STATUS}"
else
  fail "Nomad API → ${NOMAD_STATUS}"
fi
echo ""

# ── 7. abc job run (optional, requires abc CLI in PATH) ───────────────────────
echo "── abc job run hello-cluster ─────────────────────────────────────────────"
if command -v abc &>/dev/null; then
  export NOMAD_ADDR="http://${VM_IP}:4646"
  if abc job run --cores 1 --mem 512M hello-cluster 2>&1 | tail -5; then
    ok "abc job run hello-cluster succeeded"
  else
    warn "abc job run hello-cluster failed (non-fatal)"
  fi
else
  warn "abc CLI not in PATH — skipping abc job run test"
  echo "    export NOMAD_ADDR=http://${VM_IP}:4646"
  echo "    abc job run --cores 1 --mem 512M hello-cluster"
fi
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
  echo "  All checks passed."
else
  echo "  ${FAILED} check(s) FAILED. Review output above."
fi
echo ""
echo "  Access points:"
if [[ "$HTTPS_MODE" == "true" ]]; then
  echo "    MinIO S3 HTTPS:  https://${VM_IP}:9443         (--insecure / trust cert)"
  echo "    MinIO Console:   https://${VM_IP}:9444         (--insecure)"
  echo "    tusd HTTPS:      https://${VM_IP}:1443/files/  (--insecure)"
  echo ""
  echo "  Trust cert on macOS:"
  echo "    multipass exec abc-node -- cat /etc/caddy/certs/server.crt \\"
  echo "      > /tmp/abc-node.crt"
  echo "    sudo security add-trusted-cert -d -r trustRoot \\"
  echo "      -k /Library/Keychains/System.keychain /tmp/abc-node.crt"
else
  echo "    MinIO S3:        http://${VM_IP}:9000"
  echo "    MinIO Console:   http://${VM_IP}:9001"
  echo "    tusd:            http://${VM_IP}:1080/files/"
  echo ""
  echo "  Enable HTTPS: pulumi config set enableHttps true && pulumi up"
fi
echo "    fx-tusd-hook:    http://${VM_IP}:14002/healthz  (Nomad job)"
echo "    Nomad UI:        http://${VM_IP}:4646/ui"
echo "══════════════════════════════════════════════════════════"
[[ $FAILED -eq 0 ]]
