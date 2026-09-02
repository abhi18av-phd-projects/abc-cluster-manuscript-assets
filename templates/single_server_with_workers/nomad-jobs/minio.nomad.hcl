# minio.nomad.hcl
#
# MinIO object store as a Nomad service job on a client VM.
# Provides the S3-compatible backend required for FusionFS workdir testing.
#
# FusionFS (Seqera) uses this as the object store backend: Nextflow writes
# task outputs to S3 (MinIO), and FusionFS mounts them as a virtual filesystem
# inside each container via FUSE — no NFS or shared block storage required.
#
# Deploy:
#   export NOMAD_ADDR=http://192.168.252.14:4646
#   export NOMAD_TOKEN=<bootstrap-token>
#   nomad job run minio.nomad.hcl
#
# Verify:
#   nomad job status minio
#   curl http://<client-ip>:9000/minio/health/live
#   mc alias set seedling http://<client-ip>:9000 minioadmin minioadmin
#   mc mb seedling/nf-work
#
# FusionFS nextflow.config additions (after MinIO is up):
#   fusion {
#     enabled    = true
#     exportStorageCredentials = true
#   }
#   wave {
#     enabled = true
#   }
#   process.scratch = false
#   workDir = "s3://nf-work"
#
#   aws {
#     accessKey = "minioadmin"
#     secretKey = "minioadmin"
#     client {
#       endpoint        = "http://<client-ip>:9000"
#       s3PathStyleAccess = true
#     }
#   }
#
# Note: FusionFS requires a Seqera Wave token. Set NXF_WAVE_TOKEN=<token>
# or configure wave.endpoint if running a self-hosted Wave instance.

job "minio" {
  type        = "service"
  datacenters = ["dc1"]
  # Pinned to the pool the clients register into. Clients declare
  # node_pool = "compute" so the CLI's default target works; a platform job
  # that omits it targets "default", finds no clients there, and fails with
  #   Placement Failure: No nodes were eligible for evaluation
  node_pool   = "compute"
  namespace   = "abc-reserved"

  group "minio" {
    count = 1

    # Constrain to a specific client so the data volume path is stable.
    # MinIO uses a host path for persistence — pinning to one node prevents
    # data loss if Nomad reschedules the allocation to a different client.
    constraint {
      attribute = "${node.unique.name}"
      value     = "abc-worker-0"
    }

    network {
      port "api"     { static = 9000 }
      port "console" { static = 9001 }
    }

    # Persist MinIO data across restarts via a host volume.
    # The host volume "minio-data" must be registered on the client — see
    # host-volumes.hcl on the client VM (add it alongside the nf-work volume).
    # For quick validation without persistence, use a local ephemeral path instead.
    volume "minio-data" {
      type      = "host"
      read_only = false
      source    = "minio-data"
    }

    task "minio" {
      driver = "docker"

      volume_mount {
        volume      = "minio-data"
        destination = "/data"
        read_only   = false
      }

      config {
        image   = "minio/minio:RELEASE.2024-11-07T00-52-20Z"
        command = "server"
        args    = ["/data", "--console-address", ":9001"]
        ports   = ["api", "console"]
      }

      env {
        MINIO_ROOT_USER     = "minioadmin"
        MINIO_ROOT_PASSWORD = "minioadmin"
        # Advertise the host IP so cross-VM presigned URLs resolve correctly.
        # MINIO_SERVER_URL is used by clients; MINIO_BROWSER_REDIRECT_URL for console.
        MINIO_SERVER_URL    = "http://${NOMAD_HOST_ADDR_api}"
      }

      resources {
        cpu    = 500
        memory = 512
      }

      service {
        name     = "minio"
        port     = "api"
        provider = "nomad"

        check {
          type     = "http"
          path     = "/minio/health/live"
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
