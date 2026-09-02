# abc-traefik.nomad.hcl
#
# Traefik v3 HTTP router for the abc-node userspace + auth gateway layer.
# Part of ADR-0053 §2 — this HCL is canonical here and inherited by
# single-server-with-workers and abc-cluster via filesystem inheritance.
#
# What this fronts:
#   /minio-ui/*      → MinIO console      (forward-auth required)
#   /files/*         → tusd upload svc    (forward-auth required)
#   /signup/*        → signup-svc-future  (forward-auth required) — pending
#   /verify         → forward-auth health (no auth)
#   /                → catch-all (404 with message)
#
# What this does NOT front (researchers hit these directly):
#   Nomad API :4646   — abc-cluster-cli, nf-nomad use raw token auth
#   MinIO S3  :9000   — AWS-SDK clients use raw access_key/secret_key
#
# Deploy:
#   export NOMAD_ADDR=http://<server-ip>:4646
#   export NOMAD_TOKEN=<bootstrap-token>
#   nomad job run abc-traefik.nomad.hcl
#
# Verify:
#   curl -i http://<client-0-ip>/verify
#       → forwarded to abc-forward-auth, expects X-Nomad-Token header
#   curl http://<client-0-ip>:8080/api/rawdata  (dashboard; ACL-protected
#       via Tailscale ACL upstream, not via Traefik itself in this seedling layer)

job "abc-traefik" {
  type        = "service"
  datacenters = ["dc1"]
  # Pinned to the pool the clients register into. Clients declare
  # node_pool = "compute" so the CLI's default target works; a platform job
  # that omits it targets "default", finds no clients there, and fails with
  #   Placement Failure: No nodes were eligible for evaluation
  node_pool   = "compute"

  group "traefik" {
    count = 1

    # Pin to client-0 so :80 is a stable, predictable host:port for researchers.
    # In single-server-with-workers / abc-cluster this constraint is replaced by
    # a node-class match for "ingress" nodes.
    constraint {
      attribute = "${node.unique.name}"
      value     = "abc-worker-0"
    }

    network {
      port "http"      { static = 80 }
      port "dashboard" { static = 8080 }
    }

    task "traefik" {
      driver = "docker"

      config {
        image        = "traefik:v3.0"
        network_mode = "host"
        args = [
          "--providers.file.directory=/local/dynamic",
          "--providers.file.watch=true",
          "--entrypoints.web.address=:80",
          "--entrypoints.traefik.address=:8080",
          "--api.dashboard=true",
          "--api.insecure=true",
          "--log.level=INFO",
          "--accesslog=true",
        ]
      }

      # Static-host backends: forward-auth and MinIO live on the same client
      # VM (NOMAD_IP_* env vars resolve to the allocation's bind address).
      # In a multi-client topology this becomes Nomad service discovery via
      # consul-template / nomad service blocks; for the seedling we keep it
      # simple and reach the in-host static services by IP.
      template {
        destination = "local/dynamic/services.yml"
        change_mode = "noop"
        data = <<EOH
http:
  middlewares:
    forward-auth:
      forwardAuth:
        address: "http://127.0.0.1:4181/verify"
        trustForwardHeader: true
        authResponseHeaders:
          - "X-Auth-User"
          - "X-Auth-Group"
          - "X-Auth-Namespace"
          - "X-Auth-Policies"

  routers:
    forward-auth-health:
      rule: "PathPrefix(`/verify`)"
      entryPoints: ["web"]
      service: forward-auth-svc

    minio-ui:
      rule: "PathPrefix(`/minio-ui`)"
      entryPoints: ["web"]
      service: minio-console
      middlewares: ["forward-auth"]

    # tusd resumable-upload server (abc-tusd.nomad.hcl). Authed via
    # forward-auth — the abc CLI uploader presents Authorization: Bearer,
    # the browser/Uppy portal presents X-Nomad-Token.
    tusd:
      rule: "PathPrefix(`/files`)"
      entryPoints: ["web"]
      service: tusd
      middlewares: ["forward-auth"]

    # signup-svc — placeholder; ships in single-server-with-workers.
    signup:
      rule: "PathPrefix(`/signup`)"
      entryPoints: ["web"]
      service: signup
      middlewares: ["forward-auth"]

  services:
    forward-auth-svc:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:4181"

    minio-console:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9001"

    tusd:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:1080"

    signup:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8088"
EOH
      }

      resources {
        cpu    = 200
        memory = 128
      }

      service {
        name     = "abc-traefik"
        port     = "http"
        provider = "nomad"

        check {
          type     = "http"
          path     = "/verify"
          interval = "10s"
          timeout  = "3s"
          # 401 is the healthy steady state when no token is presented —
          # forward-auth is up. Any 5xx means Traefik or forward-auth down.
          # `ignore_warnings` is a Consul-check option. This job uses Nomad
          # service discovery, and Nomad rejects the whole job with:
          #   ignore_warnings on check_restart only supported for Consul service checks
          # Nomad checks have no warning state, so the option has no meaning here.
          check_restart {
            limit = 3
            grace = "30s"
          }
        }
      }

      logs {
        max_files     = 3
        max_file_size = 10
      }
    }
  }
}
