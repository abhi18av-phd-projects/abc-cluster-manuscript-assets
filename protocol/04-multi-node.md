# Running the pipelines on a multi-node deployment

The single-node protocol ([02](02-run-workload.md), [03](03-expected-output.md))
runs everything on one machine. This document covers the same pipelines against
a Nomad server with separate worker nodes, provisioned by
[`templates/single_server_with_workers`](../templates/single_server_with_workers/README.md).

Nothing about the pipelines changes. What changes is that each process is
scheduled onto a worker that is a distinct Nomad node, which is the point.

## 1. Provision

Follow the template README. For the pipelines below, two workers at
4 vCPU / 12 GB each is enough.

Confirm both workers registered before going further — a pipeline whose workers
cannot place will wait indefinitely rather than fail:

```bash
TOKEN=$(multipass exec abc-server -- sudo awk '/^Secret ID/ {print $NF}' /etc/nomad-bootstrap-token)
multipass exec abc-server -- sudo env NOMAD_ADDR=http://127.0.0.1:4646 \
  NOMAD_TOKEN=$TOKEN nomad node status
```

## 2. Write the context

The multi-node template does not yet emit a context file, so write one. Take the
server address, the token above, and the address of the worker running MinIO:

```bash
# which worker is hosting MinIO
for w in abc-worker-0 abc-worker-1; do
  ip=$(multipass info "$w" --format csv | awk -F, 'NR==2{print $3}')
  curl -sf -m 4 "http://$ip:9000/minio/health/live" >/dev/null && echo "MinIO on $w ($ip)"
done
```

```yaml
version: "1.0"
active_context: multi
contexts:
  multi:
    access_token: <bootstrap token>
    endpoint: http://<server-ip>:4646
    upload_endpoint: http://<minio-worker-ip>:1080/files/
    admin:
      services:
        nomad:
          addr: http://<server-ip>:4646
          token: <bootstrap token>
          head_pool: compute
          worker_pool: compute
        minio:
          access_key: minioadmin
          secret_key: minioadmin
          cred_source:
            local:
              endpoint: http://<minio-worker-ip>:9000
              http: http://<minio-worker-ip>:9001
              user: minioadmin
              password: minioadmin
      tools:
        endpoint: http://<minio-worker-ip>:9000
```

```bash
export ABC_CLI_CONFIG_FILE=$PWD/abc.yaml
abc auth context add --from-file abc-context.yaml
```

`head_pool` and `worker_pool` must both be `compute`, matching the pool the
workers register into.

## 3. Create the work-dir bucket

The pipelines use an S3 work dir, so the bucket must exist:

```bash
multipass exec abc-worker-0 -- sudo bash -c '
  export MC_HOST_local=http://minioadmin:minioadmin@<minio-worker-ip>:9000
  mc mb --ignore-existing local/nf-work'
```

## 4. Run the pipelines

```bash
abc pipeline run <url> --revision <tag> [--profile test] \
  --work-dir s3://nf-work/<name>/ \
  --param outdir=s3://nf-work/<name>-results/ \
  --plugin nf-nomad@0.5.0-edge5
```

| Pipeline | URL | Revision | Profile |
| --- | --- | --- | --- |
| `nextflow-io/hello` | `https://github.com/nextflow-io/hello` | `master` | — |
| `nextflow-io/rnaseq-nf` | `https://github.com/nextflow-io/rnaseq-nf` | `master` | — |
| `nf-core/demo` | `https://github.com/nf-core/demo` | `1.2.0` | `test` |

Run them in that order: `hello` finishes in about a minute and fails fast if the
executor, the object store or the node pool disagree.

## Observed output

Verified on a server plus two workers, Ubuntu 24.04, abc CLI v0.1.76,
nf-nomad 0.5.0-edge5, Nomad v1.11.2.

| Pipeline | Processes | Result |
| --- | ---: | --- |
| `nextflow-io/hello` | 4 | completed, 64 s |
| `nextflow-io/rnaseq-nf` | 4 | completed — INDEX, FASTQC, QUANT, MULTIQC |
| `nf-core/demo` 1.2.0 | 8 | `Pipeline completed successfully` |

Each process is submitted as its own Nomad job:

```
[7c/05314f] Submitted process > NFCORE_DEMO:DEMO:COWPY
[c6/8ab870] Submitted process > NFCORE_DEMO:DEMO:FASTQC (SAMPLE1_PE)
[f9/4cd7d6] Submitted process > NFCORE_DEMO:DEMO:SEQTK_TRIM (SAMPLE1_PE)
[e2/c61e1b] Submitted process > NFCORE_DEMO:DEMO:MULTIQC (demo)
-[nf-core/demo] Pipeline completed successfully-
```

The head reports the object store it staged through, which confirms the
`abc-tools` volume supplied `s5cmd` to the task:

```
nf-nomad-s5cmd: active; endpoint=http://<minio-worker-ip>:9000 region=us-east-1 pathStyle=true
```

## If a pipeline sits and never finishes

Check for a placement failure before anything else:

```bash
multipass exec abc-server -- sudo env NOMAD_ADDR=http://127.0.0.1:4646 \
  NOMAD_TOKEN=$TOKEN nomad job status <job-id>
```

`Placement Failure … No nodes were eligible for evaluation` means the job's node
pool has no clients — usually a context whose `head_pool`/`worker_pool` does not
say `compute`. `Dimension "memory" exhausted` means a process asked for more than
a worker has; raise `clientMemory`.

## Known gap

`abc doctor` can report `probe job complete — timed out after 1m0s` on a freshly
provisioned cluster. The probe submits correctly; the check's one-minute window
simply expires while Docker pulls the image on a cold worker. Re-running it after
the first job succeeds passes.
