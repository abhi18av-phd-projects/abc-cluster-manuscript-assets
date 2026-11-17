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
# Where the server comes from:
#   MinIO's community edition is end-of-life. The `minio/minio` image this job
#   used to pull is gone from Docker Hub and Quay, and dl.min.io answers
#   HTTP 410. The same build (RELEASE.2024-11-07T00-52-20Z) is therefore
#   fetched as a binary by Nomad's artifact block, which refuses it unless the
#   sha256 matches, and run inside a stock ubuntu image. If the upstream URL
#   stops answering, point the job at the mirrored copy:
#     nomad job run -var minio_binary_url=https://github.com/abhi18av-phd-projects/abc-cluster-manuscript-assets/releases/download/1.0.2/minio.linux-amd64.RELEASE.2024-11-07T00-52-20Z minio.nomad.hcl
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

variable "minio_binary_url" {
  type        = string
  description = "Where to fetch the MinIO server binary. The checksum below pins the build whatever the source."
  default     = "https://github.com/minio/minio/releases/download/RELEASE.2024-11-07T00-52-20Z/minio.linux-amd64.RELEASE.2024-11-07T00-52-20Z"
}

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

      # The server binary, pinned by checksum. Nomad places it in the task's
      # local/ directory, which the container sees at /local.
      artifact {
        source      = var.minio_binary_url
        destination = "local/minio"
        mode        = "file"
        options {
          checksum = "sha256:c27873d791b56d33518de11f12c5bfae4be88ebac00e12c6dd0027b08123fd80"
        }
      }

      config {
        # MinIO is a static binary; the image only supplies a userland.
        image   = "ubuntu:24.04"
        command = "/bin/sh"
        args    = ["-c", "chmod +x /local/minio && exec /local/minio server /data --console-address :9001"]
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
