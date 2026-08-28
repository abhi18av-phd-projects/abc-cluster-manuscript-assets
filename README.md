# ABC-cluster manuscript assets

Deployment templates and a reviewer protocol for ABC-cluster, the command-line platform that
turns commodity, heterogeneous hardware into an analytical cluster. Companion artefact to the
ABC-cluster manuscript: it lets a reviewer stand up each topology the paper describes and run
the worked example against it.

## Start here

Three documents, in order, from a bare laptop to the output the manuscript reports.

| | | |
|---|---|---|
| 1 | [Provision](protocol/01-provision.md) | bring up a cluster, single-node or single-server with workers |
| 2 | [Run](protocol/02-run-workload.md) | run the worked example and collect its output |
| 3 | [Verify](protocol/03-expected-output.md) | what a correct run produces, and the reference values to compare against |

The single-node template is the intended starting point. It needs no cloud account and no
institutional hardware, and it runs on a laptop with Multipass installed.

## Scope

This repository carries **only the two topologies the manuscript recommends**, under the same
identifiers used in Table 3 of the paper.

| Template | Manuscript identifier | Nomad mode | Access control | Users |
|---|---|---|---|---|
| [`single-node/`](templates/single-node/) | `single_node_server_worker` | development, no persistence | none | 1 |
| [`single-server-with-workers/`](templates/single-server-with-workers/) | `single_server_with_workers` | server and client, persistent | enabled | 2–20 |

A multi-server quorum topology is possible and is deliberately **not** shipped here. The paper
documents it rather than recommending it, because quorum brings leader election, split-brain
recovery and coordinated rolling upgrades, and those presume the platform-engineering capacity
the target setting does not have.

## What is deliberately absent

The paper argues that a domain-specific platform is defined as much by what it declines as by
what it delivers. This repository holds that line, so nothing here provisions:

- **SLURM or PBS bridge clusters.** The manuscript states that bridge drivers for PBS, SLURM,
  LSF and Torque are deliberately absent, since emulating an HPC scheduler imports an
  operational model the setting neither needs nor sustains.
- **Admission control, a policy engine or an audit ledger.** The manuscript records their
  absence as a decision rather than an omission, on the grounds that each introduces
  operational machinery the target institution would then have to run.
- **Identity, workflow or authorisation services** beyond `abc-auth-svc`, which brokers the
  single login and is recommended at the single-server topology only.

If you are looking for those, they belong to work reported separately.

## Relationship to the platform repositories

| Repository | What it holds |
|---|---|
| [`abc-cluster/abc-cluster-cli`](https://github.com/abc-cluster/abc-cluster-cli) | the `abc` binary itself, cited as C2 in the manuscript |
| this repository | the templates and the reviewer protocol, sanitised for publication |
| [`incsteps/pulumi-provider-multipass`](https://github.com/incsteps/pulumi-provider-multipass) | the Multipass provider the templates consume, pinned to v0.1.0 |

### The Multipass provider

The templates stand up their VMs through a Pulumi native provider for Canonical Multipass,
developed openly at [`incsteps/pulumi-provider-multipass`](https://github.com/incsteps/pulumi-provider-multipass)
and released under Apache 2.0. It is a separate artefact from this work and is not claimed as a
contribution of the manuscript.

The provider is **not yet in the public Pulumi registry**. Its registry submission is
[pulumi/registry#12177](https://github.com/pulumi/registry/pull/12177), open at the time of
writing. Until that merges, installation is from GitHub release assets and the version must be
pinned explicitly; [Provision](protocol/01-provision.md) gives the exact command. If the
submission has merged by the time you read this, `pulumi plugin install resource multipass`
resolves from the registry and the manual step can be skipped.

Every site-specific value in `templates/` is a placeholder in angle brackets. Substitute before
deploying.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
