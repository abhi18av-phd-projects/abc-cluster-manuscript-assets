# abc-forward-auth.nomad.hcl
#
# Stateless HTTP service that implements the Traefik ForwardAuth contract for
# the abc-node stack. Validates a researcher's Nomad ACL token via
# `GET /v1/acl/token/self` and returns identity headers that Traefik forwards
# to backend services (MinIO console, tusd, signup-svc).
#
# Contract (called by Traefik's forwardAuth middleware):
#   Request:
#     ANY /verify
#     Token as EITHER  X-Nomad-Token: <secret-id>   (browser / Uppy portal)
#                OR    Authorization: Bearer <secret-id>  (abc CLI tus uploader)
#     (optional: X-Forwarded-* headers)
#   Response on valid token:
#     HTTP 200
#     X-Auth-User:       <token name>        (or "anonymous" if name unset)
#     X-Auth-Group:      <first policy>      (heuristic — see note below)
#     X-Auth-Namespace:  <first namespace from policies>
#     X-Auth-Policies:   <comma-joined>
#   Response on missing/invalid token:
#     HTTP 401
#
# Implementation: bash + python3 http.server, packaged in a tiny ubuntu image.
# This is the STUB referenced in ADR-0053 — the dedicated
# `ghcr.io/abc-cluster/abc-forward-auth` image is pending. The HTTP contract
# above is identical to what the dedicated image will implement, so backend
# services consuming X-Auth-* headers do not change when the image swaps in.
# TODO(abc-forward-auth-image): replace docker image once published.
#
# Deploy:
#   export NOMAD_ADDR=http://<server-ip>:4646
#   export NOMAD_TOKEN=<bootstrap-token>
#   nomad job run abc-forward-auth.nomad.hcl
#
# Health check (from the Traefik allocation):
#   curl -i -H "X-Nomad-Token: <valid-token>" http://127.0.0.1:4181/verify
#       → 200 with X-Auth-* headers
#   curl -i http://127.0.0.1:4181/verify
#       → 401

job "abc-forward-auth" {
  type        = "service"
  datacenters = ["dc1"]
  # Pinned to the pool the clients register into. Clients declare
  # node_pool = "compute" so the CLI's default target works; a platform job
  # that omits it targets "default", finds no clients there, and fails with
  #   Placement Failure: No nodes were eligible for evaluation
  node_pool   = "compute"
  namespace   = "abc-reserved"

  group "forward-auth" {
    count = 1

    # Co-locate with Traefik on client-0 so the loopback URL in
    # abc-traefik.nomad.hcl (http://127.0.0.1:4181) resolves.
    constraint {
      attribute = "${node.unique.name}"
      value     = "abc-worker-0"
    }

    network {
      port "http" { static = 4181 }
    }

    task "forward-auth" {
      driver = "docker"

      config {
        image        = "python:3.12-slim"
        network_mode = "host"
        command      = "/local/forward-auth.py"
      }

      env {
        # The Nomad API is on the server VM; the client VM reaches it over
        # the Multipass subnet. This is injected by the Pulumi local.Command
        # that templates the job in single-server-with-workers/index.ts via the
        # `meta.nomad_addr` substitution. For local debugging override here.
        NOMAD_ADDR = "${NOMAD_ADDR_OVERRIDE}"
        LISTEN_ADDR = "0.0.0.0"
        LISTEN_PORT = "4181"
      }

      template {
        destination = "local/forward-auth.py"
        perms       = "0755"
        change_mode = "restart"
        data = <<EOH
#!/usr/bin/env python3
"""abc-forward-auth — Traefik ForwardAuth backend for seedling stack.

Validates a Nomad ACL token via /v1/acl/token/self. The token is accepted
EITHER as X-Nomad-Token (browser / Uppy portal) OR as an RFC 6750 bearer
token in Authorization (the abc CLI tus uploader). This is the seedling
stub; dedicated image (ghcr.io/abc-cluster/abc-forward-auth) will replace
it without changing the HTTP contract.
"""
import json
import os
import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

NOMAD_ADDR = os.environ.get("NOMAD_ADDR", "http://127.0.0.1:4646").rstrip("/")
LISTEN_ADDR = os.environ.get("LISTEN_ADDR", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "4181"))


def lookup_token(token):
    """Call Nomad's /v1/acl/token/self and return parsed identity, or None."""
    if not token:
        return None
    req = urllib.request.Request(
        f"{NOMAD_ADDR}/v1/acl/token/self",
        headers={"X-Nomad-Token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        return None
    except Exception as e:
        sys.stderr.write(f"[forward-auth] lookup error: {e}\n")
        return None


class Handler(BaseHTTPRequestHandler):
    def _verify(self):
        # Accept the token either as X-Nomad-Token (browser / Uppy portal)
        # or as an RFC 6750 bearer token in Authorization (abc CLI tus
        # uploader, which uses standard Authorization: Bearer).
        token = self.headers.get("X-Nomad-Token", "")
        if not token:
            auth = self.headers.get("Authorization", "")
            if auth[:7].lower() == "bearer ":
                token = auth[7:].strip()
        info = lookup_token(token)
        if not info:
            self.send_response(401)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"unauthorized: missing or invalid token (X-Nomad-Token or Authorization: Bearer)\n")
            return

        # Heuristics — the dedicated image will swap to claims-driven mapping.
        # Token "Name" → user; first policy → group; first namespace in
        # policies → namespace. Management tokens get group="admin",
        # namespace="*".
        name = info.get("Name") or "anonymous"
        ttype = info.get("Type", "client")
        policies = info.get("Policies") or []
        if ttype == "management":
            group = "admin"
            namespace = "*"
            policy_str = "management"
        else:
            group = policies[0] if policies else "unknown"
            # Convention: policy name "member-<group>" → namespace "<group>".
            ns_guess = group
            if group.startswith("member-"):
                ns_guess = group[len("member-"):]
            namespace = info.get("Namespace") or ns_guess
            policy_str = ",".join(policies)

        self.send_response(200)
        self.send_header("X-Auth-User", name)
        self.send_header("X-Auth-Group", group)
        self.send_header("X-Auth-Namespace", namespace)
        self.send_header("X-Auth-Policies", policy_str)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok\n")

    def do_GET(self):
        if self.path.startswith("/verify"):
            return self._verify()
        if self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        return self.do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("[forward-auth] " + (fmt % args) + "\n")


if __name__ == "__main__":
    sys.stderr.write(f"[forward-auth] NOMAD_ADDR={NOMAD_ADDR} "
                     f"listen={LISTEN_ADDR}:{LISTEN_PORT}\n")
    HTTPServer((LISTEN_ADDR, LISTEN_PORT), Handler).serve_forever()
EOH
      }

      resources {
        cpu    = 100
        memory = 96
      }

      service {
        name     = "abc-forward-auth"
        port     = "http"
        provider = "nomad"

        check {
          type     = "http"
          path     = "/healthz"
          interval = "10s"
          timeout  = "3s"
        }
      }

      logs {
        max_files     = 3
        max_file_size = 10
      }
    }
  }
}
