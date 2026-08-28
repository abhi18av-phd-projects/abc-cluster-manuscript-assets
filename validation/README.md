# Validation and supplemental data

What the worked example deposits, and why each item earns its place. Nothing here is a
measurement for its own sake: every item makes a specific claim in the manuscript checkable by
someone who does not trust it.

## Tier 1 — required by the journal

| Item | Path | Why |
|---|---|---|
| Public dataset accessions | `configs/datasets.md` | The Data Availability statement cannot be written without them. Use nf-core test data or a public ENA/SRA project. **No participant-derived data.** |
| Code snapshot DOI | `.zenodo.json`, this repo | SoftwareX asks that a release carry a DOI via Zenodo or Software Heritage |
| Host specification | `results/host-spec.md` | Timings below are meaningless without the machine they were taken on |

## Tier 2 — makes the paper's central claim checkable

The manuscript argues that reproducibility is "a consequence of submitting work rather than an
act of discipline". That is the claim most worth attacking, so it should be the best evidenced.

| Item | Path | Claim it evidences |
|---|---|---|
| Reproducibility manifest from the worked run | `results/manifest.json` | Per-task container digest, registry URL, resolution timestamp, resolution path and lockfile reference, captured without anyone electing to record them |
| Environment lockfile as used | `configs/pixi.lock` | That an environment can be rebuilt byte-identically elsewhere |
| Output checksums | `results/checksums.sha256` | Turns "the same outputs" into something a reader can verify rather than accept |
| Generated Nomad job specification | `configs/generated-job.hcl` | Shows what the CLI actually produces from a submission, which no prose description substitutes for |

## Tier 3 — evidences the infrastructure argument

| Item | Path | Claim it evidences |
|---|---|---|
| tus interruption trace | `results/tus-resume.log` | The strongest infrastructure claim in the paper: an interrupted transfer resumes from the last acknowledged offset rather than from zero. Cheap to produce, and it directly answers the intermittent-connectivity assumption |
| Provisioning timings | `results/provision-times.md` | Time from bare VM to `abc cluster doctor` passing, per topology. Supports "an institution can afford to own and operate it" |
| Pipeline walltime and peak memory | `results/pipeline-resources.md` | That the worked example runs within a commodity resource envelope |
| `abc report` output | `results/abc-report.txt` | That spend, provenance and project context are recorded as a property of running |

## Optional

A single screencast is permitted by the SoftwareX template, MP4 only, 150 MB maximum, 640x480 at
up to 30 fps, displayed beside the article. A command-line platform demonstrates well in that
format, and it is the cheapest way to show a reviewer the three workload classes under one
credential.

## Exclusions

- No participant-derived sequence data. Public test datasets only.
- No institutional hostnames, node names, usernames or tokens in any deposited artefact.
- No internal tier vocabulary in filenames, logs or figures.
- Scrub `abc report` output of real user identifiers before deposit.

## Open

The manuscript's Data Availability statement is unwritten and blocks submission. It needs the
accessions from `configs/datasets.md`, which in turn need the worked example to have been run.
