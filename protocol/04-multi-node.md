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

## 2. Get an account

Provisioning seeds the slot store, so accounts already exist. Group and member
names are drawn at random per deployment; read the ones this cluster got:

```bash
multipass exec abc-server -- sudo cat /var/log/abc-workbench-seed.log
```

```
Seeded groups: caracal-proteomics, aardvark-phylogenetics, duiker-metagenomics
Seeded slots:  farai, lerato, tinashe, reviewer
```

Each member slot belongs to one group. `reviewer` is a super-admin: a Nomad
management token, MinIO `consoleAdmin` plus every group member policy, and
JupyterHub admin rights. Take a member slot to see the access control working;
take `reviewer` to see everything at once.

Read its claim code:

```bash
multipass exec abc-server -- sudo python3 -c \
  "import json; d=json.load(open('/run/abc-seed-out.json')); print(d['groups'][0]['claim_code'])"
```

Redeem it. Keep the config out of `~/.abc/config.yaml` so an existing context is
not disturbed:

```bash
export ABC_CLI_CONFIG_FILE=$PWD/reviewer.yaml
abc auth claim <CLAIM-CODE> \
  --endpoint http://<server-ip>:4182/slots/claim \
  --email you@example.org --name "Your Name" --consent
```

```
Claimed slot. Imported 1 context(s); active context: "abc-cluster"
```

That single command writes a complete, working config — Nomad address and token,
the group namespace, MinIO endpoint and per-slot credentials, and the upload
endpoint. Nothing needs to be filled in by hand:

```yaml
admin:
  id: pool-farai
  services:
    minio:
      access_key: farai-ejpxd7
      endpoint: http://<minio-worker-ip>:9000
    nomad:
      addr: http://<server-ip>:4646
      head_pool: compute
      namespace: su-caracal-proteomics
      worker_pool: compute
```

A claim code is single-use. Claiming again returns `code_invalid_or_used`; take
the next slot's code from the same file.

### Without the workbench

With `enableWorkbench false` there is no broker and no seeded account, so write
a context by hand from the bootstrap token and the MinIO root credentials. This
is the operator path — it holds a cluster-wide management token, so prefer a
claimed slot whenever the workbench is on:

```bash
TOKEN=$(multipass exec abc-server -- sudo awk '/^Secret ID/ {print $NF}' /etc/nomad-bootstrap-token)
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

## 3. Work-dir bucket

A claimed slot already has one: the seed creates the group bucket `su-<group>`,
and the slot's MinIO credentials are scoped to it. Use it directly — there is
nothing to create.

A slot cannot write outside its own group's bucket, which is the access control
doing its job. `s3://nf-work/` belongs to the operator path below and returns
`AccessDenied` for a member slot.

For the hand-written operator context, create the shared bucket:

```bash
multipass exec abc-worker-0 -- sudo bash -c '
  export MC_HOST_local=http://minioadmin:minioadmin@<minio-worker-ip>:9000
  mc mb --ignore-existing local/nf-work'
```

## 4. Run the pipelines

```bash
NS=$(grep -m1 'namespace:' "$ABC_CLI_CONFIG_FILE" | awk '{print $2}')   # su-<group>

abc pipeline run <url> --revision <tag> [--profile test] \
  --work-dir "s3://$NS/nf-work/<name>/" \
  --plugin nf-nomad@0.5.0-edge5 --wait --logs
```

Results land under `s3://<namespace>/user/<slot>/results/` automatically, so
`--param outdir=` is only needed to put them somewhere else. On the operator
context, substitute `s3://nf-work/<name>/` for the work dir.

| Pipeline | URL | Revision | Profile |
| --- | --- | --- | --- |
| `nextflow-io/hello` | `https://github.com/nextflow-io/hello` | `master` | — |
| `nextflow-io/rnaseq-nf` | `https://github.com/nextflow-io/rnaseq-nf` | `master` | — |
| `nf-core/demo` | `https://github.com/nf-core/demo` | `1.2.0` | `test` |

Run them in that order: `hello` finishes in about a minute and fails fast if the
executor, the object store or the node pool disagree.

## 5. Open the workbench

The browser workbench is on the **server**, on port 80. Log in with the slot's
MinIO access key as the username and its secret key as the password — the broker
validates those against MinIO, so there is no separate password to set:

```bash
multipass exec abc-server -- sudo python3 -c \
  "import json; d=json.load(open('/run/abc-seed-out.json'))['groups'][0]; \
   print(d['slot'], d['access_key'], d['secret_key'])"
```

Open `http://<server-ip>/` and sign in. A successful login redirects to the hub
and JupyterLab starts within a few seconds.

Each slot lands in `/data/workbench/<slot>/home`, which is also the Linux home
of `jupyter-<slot>`, so a terminal inside JupyterLab and the notebook file
browser see the same directory. `reviewer` additionally has the hub admin panel.

Check it from the shell without a browser:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<server-ip>/hub/login    # 200
```

## Observed output

Verified on a server plus two workers, Ubuntu 24.04, abc CLI v0.1.76,
nf-nomad 0.5.0-edge5, Nomad v1.11.2. The `hello` row below was re-verified on a
clean `pulumi up` with `enableWorkbench true`, run from a claimed member slot
rather than the bootstrap token — the point being that an ordinary member, with
no cluster-wide privileges, can run a pipeline end to end:

```
Submitting pipeline head job to Nomad...
  Pipeline submitted
  Job        farai-1788347937-nf-head-nextflow-io-hello
  Workdir    s3://su-caracal-proteomics/nf-work/hello/ [user-set]
  Results    s3://su-caracal-proteomics/user/farai/results/farai-1788347937/ [auto]
  Visibility user-private
```

```
[23/d642d5] Submitted process > sayHello (1)
[8a/d5a907] Submitted process > sayHello (2)
[7c/e1e5ba] Submitted process > sayHello (3)
[2b/5eed02] Submitted process > sayHello (4)
Bonjour world!
Ciao world!
Hello world!
Hola world!
```

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
