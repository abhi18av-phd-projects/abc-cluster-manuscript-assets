#!/usr/bin/env bash
# nextflow-dispatch-examples.sh
#
# Example dispatch commands for the parametric nextflow-head Nomad job.
# Run these from the Nomad server or from the host with NOMAD_ADDR set.
#
# Prerequisites:
#   export NOMAD_ADDR=http://<server-ip>:4646
#   export NOMAD_TOKEN=<bootstrap-token>   # from /opt/nf-work/.nomad-bootstrap-token on NFS share
#
# Register the job first (one time):
#   nomad job run nextflow-head.nomad.hcl
#
# Then dispatch individual pipeline runs:

# ------------------------------------------------------------------
# Hello pipeline — quick sanity check (~30s)
# ------------------------------------------------------------------
nomad job dispatch \
  -meta pipeline=hello \
  -meta revision=latest \
  nextflow-head

# ------------------------------------------------------------------
# nextflow-io/rnaseq-nf — full RNA-seq pipeline (Suite A validation)
# ------------------------------------------------------------------
nomad job dispatch \
  -meta pipeline=nextflow-io/rnaseq-nf \
  -meta revision=master \
  -meta profile=test \
  -meta outdir=/opt/nf-test/results/rnaseq-nf \
  -meta max_cpus=2 \
  -meta max_memory=3.GB \
  nextflow-head

# ------------------------------------------------------------------
# nf-core/demo — 3-sample amplicon QC pipeline (~4 min)
# ------------------------------------------------------------------
nomad job dispatch \
  -meta pipeline=nf-core/demo \
  -meta revision=dev \
  -meta profile=test \
  -meta outdir=/opt/nf-test/results/nf-core-demo \
  -meta max_cpus=2 \
  -meta max_memory=3.GB \
  nextflow-head

# ------------------------------------------------------------------
# Resume a previous run (add -resume to extra_args)
# ------------------------------------------------------------------
nomad job dispatch \
  -meta pipeline=nf-core/demo \
  -meta revision=dev \
  -meta profile=test \
  -meta outdir=/opt/nf-test/results/nf-core-demo \
  -meta extra_args="-resume" \
  nextflow-head

# ------------------------------------------------------------------
# FusionFS workdir — nf-core/demo via MinIO S3 backend
#
# Prerequisites:
#   1. MinIO deployed: nomad job run minio.nomad.hcl
#   2. Bucket created: mc mb seedling/nf-work
#   3. TOWER_ACCESS_TOKEN set in shell (Seqera platform token for Wave)
#
# Run directly (not via nextflow-head Nomad job — FusionFS needs env vars
# that raw_exec doesn't forward from the submitter's shell):
#
#   multipass exec abc-worker-0 -- bash -c "
#     NXF_VER=25.10.5 \
#     NXF_HOME=/opt/nf-work \
#     AWS_ACCESS_KEY_ID=minioadmin \
#     AWS_SECRET_ACCESS_KEY=minioadmin \
#     NXF_WAVE_TOKEN=$TOWER_ACCESS_TOKEN \
#     nextflow run nf-core/demo \
#       -r dev -profile test \
#       -c /opt/nf-test/nextflow.config \
#       -c /opt/nf-test/nextflow-fusionfs.config \
#       --outdir /opt/nf-test/results/nf-core-demo-fusion
#   "
#
# MinIO endpoint in nextflow-fusionfs.config: http://192.168.252.18:9000
# mc alias: mc alias set seedling http://192.168.252.18:9000 minioadmin minioadmin
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# Tail logs from the most recent dispatch
# ------------------------------------------------------------------
# List dispatched child jobs:
#   nomad job status nextflow-head
# Get the most recent allocation:
#   ALLOC=$(nomad job status -json nextflow-head | \
#     jq -r '.ChildStatuses[-1].ID')
# Stream logs:
#   nomad alloc logs -f "$ALLOC" run
