# Expected output

What each step of [02-run-workload.md](02-run-workload.md) produced on a clean
deployment. Your identifiers (job IDs, allocation IDs, IP addresses) will differ;
the shape of the output and the checksums should not.

Recorded 2026-08-29 against abc CLI v0.1.76, nf-nomad 0.5.0-edge4, Nomad v1.11.2,
on a single Multipass instance at 8 vCPU / 32 GB / 80 GB.

## 1. Context import

```
Imported context "lab"
Active context set to "lab"
```

The context pins the pool, which is why no later command passes `--node-pool` or
`--head-pool`:

```
addr: http://<node-ip>:4646
head_pool: compute
worker_pool: compute
```

## 2. abc doctor

```
  ━━━ 2 / 3  Connectivity
  ✓  nomad reachable                       v1.11.2 (http://<node-ip>:4646)
  ✓  nodes ready                           1 / 1

  ━━━ 3 / 3  Workload
  ✓  probe job submit                      abc-doctor-probe-39445
  ✓  probe job complete                    alloc 98c5f888

  All checks passed. abc-cluster is healthy.
```

## 3. Built-in workload

```
  Nomad job ID   script-job-hello-cluster-21c97bf8
```

and in the allocation log:

```
scenario=cpu:4,vm:0:64M,io:0,t:63s
stress-ng: info:  [21] passed: 5: cpu (4) io (1)
stress-ng: info:  [21] failed: 0
```

> `abc job run hello-cluster` with no flags selects the `containerd-driver`,
> which this template does not install, and fails preflight with
> `no eligible client node has a healthy install for containerd-driver`.
> Pass `--driver=docker` as shown in the run protocol.

## 4. tus ingestion

```
→ sample1_R1.fastq.gz
File uploaded successfully.
  Size: 3.20 MB
  Checksum: sha256:b7469350e3167dcdeab6a498984030b09af4bbf17e5b5a9e8f95dc3ee352b031
→ sample1_R2.fastq.gz
File uploaded successfully.
  Size: 3.88 MB
  Checksum: sha256:1fcbddf6dbb6d6508755477859161fa63be14246a85d4a4f75683da3f461e153
Uploaded 2/2 path(s).
```

Those two checksums are reproducible: they are the same on any deployment,
because they are properties of the files rather than of the run.

## 5. Ad-hoc job with a declared environment

```
  Nomad job ID   script-job-fastqc-covid-4624c67a
```

and in the allocation log:

```
Analysis complete for R1.fastq.gz
Analysis complete for R2.fastq.gz
R1_fastqc.html
R2_fastqc.html
```

The task exits 0. FastQC is never installed by the script: the four `#ABC`
preamble lines are the whole specification, and the lockfile is resolved when
the task starts.

## 6. Pipelines

Each row is a single run, measured on its own with nothing else on the node.
`peak memory` and `peak load` are node-level samples taken every 10 s across the
run; `disk` is the increase in used space attributable to that run, which is
dominated by container image pulls and therefore falls sharply once an image is
cached.

| Pipeline | Revision | Profile | Wall clock | Processes | Peak memory | Peak load | Disk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `nextflow-io/hello` | master | — | 1 min 16 s | 4 | 1.3 GB | 1.2 |
| `nextflow-io/rnaseq-nf` | master | — | 3 min 16 s | 4 | 1.6 GB | 2.5 |
| `nf-core/demo` | 1.2.0 | test | 3 min 16 s | 8 | 2.3 GB | 4.1 |
| `nf-core/detaxizer` | 1.3.0 | test | 7 min 47 s | 54 | 2.7 GB | 2.5 |
| `nf-core/viralrecon` | 3.0.0 | test | 57 min 1 s | 200 | 9.7 GB | 5.2 |

Measured on **8 vCPU / 20 GB / 60 GB** with nf-nomad 0.5.0-edge5, each pipeline
run on its own and with no Nextflow configuration file supplied.

with nothing else scheduled.

Two things are worth reading off this table rather than the individual numbers.
`nf-core/demo` peaks higher than `rnaseq-nf` while doing less biological work,
because nf-core's per-process resource declarations and its MultiQC step cost
more than the work they wrap at test scale. And the jump from `demo` to
`viralrecon` is a factor of five in memory and twenty-five in process count,
which is why the sizing table in [../templates/README.md](../templates/README.md)
separates them: a reviewer confirming that the platform runs does not need the
deployment the production pipelines need.

### `nf-core/viralrecon` needs its schema plugin pinned

viralrecon 3.0.0 pins `nf-schema@2.5.1` in its own `nextflow.config`. A
`plugins` block in a config passed with `-c` replaces rather than merges with
the pipeline's, so the pin is discarded and Nextflow resolves the latest
release instead. On 2.8.0 the run fails parameter validation before scheduling
anything:

```
* --bowtie2_index (): could not validate file format of '':
  Argument of `file()` function cannot be empty
ERROR ~ Validation of pipeline parameters failed!
```

Restore the pin on the command line:

```bash
abc pipeline run https://github.com/nf-core/viralrecon --revision 3.0.0 \
  --profile test --plugin nf-nomad@0.5.0-edge4 --plugin nf-schema@2.5.1 ...
```

With 2.5.1 the run completes all 200 processes. Any pipeline that pins a plugin
version needs the same treatment until the plugin blocks merge.

## 7. Publish a result

```
  GET / -> 200  2452938 bytes  text/html; charset=utf-8
  <title>MultiQC Report
```

`abc app list` reports the app healthy in the `abc-apps` namespace.
