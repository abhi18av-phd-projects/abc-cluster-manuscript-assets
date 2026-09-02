# nextflow-head.nomad.hcl
#
# Parametric batch job: runs a Nextflow pipeline as a Nomad allocation on a
# client VM. One job definition handles all pipelines — the pipeline name,
# revision, and resource caps are passed as dispatch payload or meta overrides.
#
# Usage (from the host or after `nomad acl token` auth):
#
#   # Hello pipeline (quick sanity check):
#   nomad job dispatch -meta pipeline=hello nextflow-head
#
#   # rnaseq-nf:
#   nomad job dispatch \
#     -meta pipeline=nextflow-io/rnaseq-nf \
#     -meta revision=master \
#     -meta profile=test \
#     -meta max_cpus=2 \
#     -meta max_memory=3.GB \
#     nextflow-head
#
#   # nf-core/demo:
#   nomad job dispatch \
#     -meta pipeline=nf-core/demo \
#     -meta revision=dev \
#     -meta profile=test \
#     -meta outdir=/opt/nf-test/results/nf-core-demo \
#     nextflow-head
#
# Requirements:
#   - Nextflow must be installed on the client VM at /usr/local/bin/nextflow
#     (baked by nomad-client-base.yaml cloud-init).
#   - /opt/nf-test/nextflow.config must exist (written by nomad-client-nf-setup.service).
#   - /opt/nf-work must be NFS-mounted (shared workDir, host volume "nf-work").
#   - The "nextflow" host volume must be registered on the client (see host-volumes.hcl).
#   - NXF_VER=25.10.5: nf-nomad 0.4.0-edge3 requires NF >= 25.10.0; NF 26.x v2 parser
#     rejects the closure-based volume DSL.
#   - NXF_HOME=/opt/nf-work: Nextflow injects $NXF_HOME/assets/<pipeline>/bin into
#     .command.run PATH. All container nodes mount /opt/nf-work via the nf-work host
#     volume — a server-local NXF_HOME causes exit 127 for pipelines with bin/ scripts.
#
# Topology:
#   This job runs as a Nomad BATCH allocation on a client VM. It is the Nextflow
#   "head node" — the process that orchestrates the pipeline. Each pipeline TASK is
#   itself dispatched as a further Nomad Docker job by the nf-nomad executor plugin.
#   The head job must run on an exec/raw_exec driver (not Docker) because it needs
#   direct filesystem access to /opt/nf-test/nextflow.config and /opt/nf-work.

job "nextflow-head" {
  type        = "batch"
  datacenters = ["dc1"]
  # Pinned to the pool the clients register into. Clients declare
  # node_pool = "compute" so the CLI's default target works; a platform job
  # that omits it targets "default", finds no clients there, and fails with
  #   Placement Failure: No nodes were eligible for evaluation
  node_pool   = "compute"

  # Parametric: this job is a template dispatched via `nomad job dispatch`.
  # Each dispatch creates a child batch job that runs to completion and exits.
  parameterized {
    # meta fields accepted from the dispatcher — all optional (have defaults below)
    meta_optional = [
      "pipeline",   # e.g. "hello", "nextflow-io/rnaseq-nf", "nf-core/demo"
      "revision",   # e.g. "master", "dev", "main" — default: "main"
      "profile",    # e.g. "test" — default: "test"
      "outdir",     # output directory path — default: /opt/nf-test/results/<pipeline-slug>
      "max_cpus",   # Nextflow params.max_cpus — default: 2
      "max_memory", # Nextflow params.max_memory — default: 3.GB
      "extra_args", # any additional nextflow CLI args (appended verbatim) — default: ""
    ]
  }

  group "head" {
    count = 1

    # Run on a client VM that has Nextflow installed and /opt/nf-work mounted.
    # The exec driver gives the Nextflow process host-level filesystem access so it
    # can read nextflow.config and write to /opt/nf-work without container isolation.
    task "run" {
      driver = "raw_exec"

      # Template generates the runner script with meta values interpolated.
      # Using a template (not inline args) avoids shell-quoting issues with
      # arguments that contain spaces (e.g. max_memory="3.GB").
      template {
        destination = "local/run.sh"
        perms       = "0755"
        data        = <<-TMPL
          #!/bin/bash
          set -euo pipefail

          PIPELINE="{{ or (meta "pipeline") "hello" }}"
          REVISION="{{ or (meta "revision") "main" }}"
          PROFILE="{{ or (meta "profile") "test" }}"
          MAX_CPUS="{{ or (meta "max_cpus") "2" }}"
          MAX_MEMORY="{{ or (meta "max_memory") "3.GB" }}"
          EXTRA_ARGS="{{ or (meta "extra_args") "" }}"

          # Derive a filesystem-safe slug from the pipeline name for the default outdir.
          PIPELINE_SLUG="${PIPELINE//\//-}"
          OUTDIR="{{ or (meta "outdir") "" }}"
          if [ -z "${OUTDIR}" ]; then
            OUTDIR="/opt/nf-test/results/${PIPELINE_SLUG}"
          fi

          NF_CONFIG=/opt/nf-test/nextflow.config

          if [ ! -f "${NF_CONFIG}" ]; then
            echo "[nextflow-head] ERROR: ${NF_CONFIG} not found — nomad-client-nf-setup.service may not have completed"
            exit 1
          fi

          echo "[nextflow-head] Pipeline : ${PIPELINE}"
          echo "[nextflow-head] Revision : ${REVISION}"
          echo "[nextflow-head] Profile  : ${PROFILE}"
          echo "[nextflow-head] Outdir   : ${OUTDIR}"
          echo "[nextflow-head] max_cpus : ${MAX_CPUS}"
          echo "[nextflow-head] max_mem  : ${MAX_MEMORY}"
          echo ""

          # Build the nextflow command. The -r flag is omitted for "hello" and other
          # pipelines that don't require an explicit revision (they resolve from NF hub).
          NF_CMD=(
            nextflow run "${PIPELINE}"
            -profile "${PROFILE}"
            -c "${NF_CONFIG}"
            --outdir "${OUTDIR}"
            --max_cpus "${MAX_CPUS}"
            --max_memory "${MAX_MEMORY}"
          )

          # Add revision flag only when non-empty and not the sentinel "latest".
          if [ -n "${REVISION}" ] && [ "${REVISION}" != "latest" ]; then
            NF_CMD+=( -r "${REVISION}" )
          fi

          # Append caller-provided extra args (split on whitespace — no quoting).
          if [ -n "${EXTRA_ARGS}" ]; then
            # shellcheck disable=SC2206
            NF_CMD+=( ${EXTRA_ARGS} )
          fi

          echo "[nextflow-head] Executing: NXF_VER=25.10.5 NXF_HOME=/opt/nf-work ${NF_CMD[*]}"
          exec env \
            NXF_VER=25.10.5 \
            NXF_HOME=/opt/nf-work \
            NXF_WORK=/opt/nf-work \
            "${NF_CMD[@]}"
        TMPL
      }

      config {
        command = "local/run.sh"
      }

      # Resource request for the HEAD allocation itself (the Nextflow JVM).
      # Nomad BATCH allocations run on client VMs. The JVM typically uses 512MB–1GB.
      # Individual pipeline TASKS are dispatched as separate Nomad Docker jobs by nf-nomad.
      resources {
        cpu    = 1000  # MHz — head JVM only; tasks get their own allocations
        memory = 2048  # MiB
      }

      # Log to stdout/stderr — visible via `nomad alloc logs <alloc-id>`.
      logs {
        max_files     = 5
        max_file_size = 10
      }
    }
  }
}
