# Run the worked example

Every command below is run from the deployment provisioned in
[01-provision.md](01-provision.md). Nothing here needs root on your own machine,
and nothing reaches outside the cluster except pipeline asset downloads.

The observed output of each step is recorded in
[03-expected-output.md](03-expected-output.md); this document is the sequence,
that one is the result.

## 0. Environment

The CLI is pointed at the deployment by a context, not by flags. Export a config
file for this run so nothing touches a context you already have:

```bash
export ABC_CLI_CONFIG_FILE=$PWD/abc.yaml
```

## 1. Import the context the stack emitted

```bash
pulumi stack output abcContext --show-secrets > abc-context.yaml
abc auth context add --from-file abc-context.yaml
```

The emitted context carries the Nomad endpoint, the object store, the upload
endpoint and the node pool. Because it carries the pool, no later command needs
`--head-pool` or `--node-pool`.

## 2. Verify the deployment before using it

```bash
abc doctor
```

This submits and reaps a probe job. Do not continue if it does not pass: every
later failure is easier to read once this one is green.

## 3. Built-in workload

```bash
abc job run hello-cluster
```

A synthetic CPU workload with no arguments. It confirms scheduling, the node
pool and the container driver in one command.

## 4. Ingest reads over a resumable connection

```bash
for r in R1 R2; do
  curl -sSL -o sample1_${r}.fastq.gz \
    "https://raw.githubusercontent.com/nf-core/test-datasets/viralrecon/illumina/amplicon/sample1_${r}.fastq.gz"
done
abc data upload sample1_R1.fastq.gz sample1_R2.fastq.gz
```

Transfers use the tus protocol and record a sha256 per file. Interrupt the
upload and re-run it to see it resume from the last acknowledged offset rather
than from zero.

## 5. Ad-hoc job with a declared environment

`environment.yml`:

```yaml
name: fastqc-env
channels: [conda-forge, bioconda]
dependencies: [fastqc=0.12.1]
```

`fastqc.sh`:

```bash
#ABC --name=fastqc-covid
#ABC --cores=2 --mem=4G
#ABC --driver=exec
#ABC --runtime=micromamba --from-file=environment.yml
set -euo pipefail
for r in R1 R2; do
  curl -fsSL -o $r.fastq.gz http://<node-ip>:9000/tusd/sample1_${r}.fastq.gz
done
fastqc --version
fastqc --threads 2 --outdir . R1.fastq.gz R2.fastq.gz
ls -1 *_fastqc.html
```

```bash
abc job run fastqc.sh
```

The four preamble lines are the whole specification. The lockfile is resolved
when the task starts and the resolved form is written into the run record.

## 6. Pipelines

Each pipeline runs at a pinned revision with the `test` profile. Use `test`, not
`test_full`: the full profiles pull production-sized data and are not the point
of this protocol.

```bash
abc pipeline run <url> --revision <tag> --profile test \
  --work-dir s3://nf-work/<name>/ \
  --param outdir=s3://nf-work/<name>-results/ \
  --plugin nf-nomad@0.5.0-edge4
```

| Pipeline | URL | Revision | Profile | Extra flags |
| --- | --- | --- | --- | --- |
| `nextflow-io/hello` | `https://github.com/nextflow-io/hello` | `master` | — | — |
| `nextflow-io/rnaseq-nf` | `https://github.com/nextflow-io/rnaseq-nf` | `master` | — | — |
| `nf-core/demo` | `https://github.com/nf-core/demo` | `1.2.0` | `test` | — |
| `nf-core/detaxizer` | `https://github.com/nf-core/detaxizer` | `1.3.0` | `test` | — |
| `nf-core/viralrecon` | `https://github.com/nf-core/viralrecon` | `3.0.0` | `test` | `--plugin nf-schema@2.5.1` |

viralrecon needs its schema plugin pinned explicitly; the reason is recorded in
[03-expected-output.md](03-expected-output.md).

Run them in the order listed. `nextflow-io/hello` finishes in under a minute and
fails fast if the executor, the object store or the node pool are wrong, which
saves discovering the same fault forty minutes into `viralrecon`.

## 7. Publish a result

Fetch the report, look at it, then publish it. The middle step is deliberate and
is explained in [../apps/mtbseq-90-multiqc/README.md](../apps/mtbseq-90-multiqc/README.md).

```bash
abc data pull s3://nf-work/demo-results/multiqc/multiqc_report.html .
open multiqc_report.html
abc app deploy
abc app list
```

`abc-app.yaml` names `framework: static` and the local file. No image is built
and no registry is involved.
