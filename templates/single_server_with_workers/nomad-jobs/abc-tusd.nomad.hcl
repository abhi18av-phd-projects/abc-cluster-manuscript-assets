# abc-tusd.nomad.hcl
#
# tusd resumable-upload server (S3 store → MinIO) for the abc-node
# userspace + signup layer. Part of ADR-0053 §2 — this HCL is canonical here
# and inherited by single-server-with-workers / abc-cluster via filesystem
# inheritance, mirroring abc-deployments/abc-cluster exactly EXCEPT the
# upload size cap (-max-size is a prod-only hardening, intentionally omitted
# from the throwaway sim).
#
# Upload path:
#   browser / abc CLI → Traefik /files → forward-auth → tusd :1080 → MinIO S3
#
# Credentials: tusd does NOT use the MinIO root user. A scoped MinIO service
# user `abc-tusd-svc` (policy `abc-tusd-rw`) is created by the post-deploy
# provisioner in single-server-with-workers/index.ts, and its access/secret keys are
# written to the Nomad Variable `nomad/jobs/abc-tusd`. The template block below
# renders them into the task environment.
#
# Deploy:
#   export NOMAD_ADDR=http://<server-ip>:4646
#   export NOMAD_TOKEN=<bootstrap-token>
#   nomad job run abc-tusd.nomad.hcl
#
# Verify:
#   curl -i -H "X-Nomad-Token: <valid-token>" http://<client-0-ip>/files/
#       → 200 (tus protocol; OPTIONS/POST for actual uploads)

job "abc-tusd" {
  type        = "service"
  datacenters = ["dc1"]
  # Pinned to the pool the clients register into. Clients declare
  # node_pool = "compute" so the CLI's default target works; a platform job
  # that omits it targets "default", finds no clients there, and fails with
  #   Placement Failure: No nodes were eligible for evaluation
  node_pool   = "compute"
  namespace   = "abc-reserved"

  group "tusd" {
    count = 1

    # Co-locate with Traefik / forward-auth / MinIO on client-0 so the
    # loopback URL in abc-traefik.nomad.hcl (http://127.0.0.1:1080) resolves
    # and the MinIO S3 endpoint is reachable on the same host.
    constraint {
      attribute = "${node.unique.name}"
      value     = "abc-worker-0"
    }

    network {
      port "http" { static = 1080 }
    }

    task "tusd" {
      driver = "docker"

      config {
        image        = "tusproject/tusd:sha-57276ab"
        network_mode = "host"
        args = [
          "-base-path=/files/",
          "-port=1080",
          "-behind-proxy",
          "-s3-bucket=tusd-uploads",
          "-s3-endpoint=http://${MINIO_ENDPOINT_OVERRIDE}:9000",
        ]
      }

      # Scoped MinIO credentials (abc-tusd-svc, policy abc-tusd-rw) sourced
      # from the Nomad Variable nomad/jobs/abc-tusd. Never the MinIO root user.
      template {
        destination = "secrets/tusd.env"
        env         = true
        change_mode = "restart"
        data        = <<EOH
{{- with nomadVar "nomad/jobs/abc-tusd" }}
AWS_ACCESS_KEY_ID={{ .AWS_ACCESS_KEY_ID }}
AWS_SECRET_ACCESS_KEY={{ .AWS_SECRET_ACCESS_KEY }}
{{- end }}
AWS_REGION=us-east-1
EOH
      }

      resources {
        cpu    = 200
        memory = 128
      }

      service {
        name     = "abc-tusd"
        port     = "http"
        provider = "nomad"

        check {
          type     = "http"
          path     = "/files/"
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
