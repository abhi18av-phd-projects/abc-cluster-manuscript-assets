# mtbseq-90-multiqc

The MultiQC report from the 90-sample MTBseq-nf run, published as a static app.

This is the manuscript's data-app example. It exists to show one thing: a result
produced by a pipeline on the platform can be published from the same platform,
with one command and no application code.

## Why static, and why no Dockerfile

ADR-0062 treats the static asset app as the preferred runtime shape — no
application process, nothing to keep alive, strongest sovereignty. MultiQC emits
a single self-contained HTML file with its data inlined, so it needs no server
logic, no data connection and no session.

`content:` publishes that file directly. The CLI hashes it, uploads it to a
reserved bucket under its digest, and the generated job fetches it as a Nomad
artifact into the allocation directory, where a platform-supplied Caddy serves
it. There is no image to build and no registry to push to.

## Deploy

```bash
# 1. Fetch the report the pipeline produced
abc data download s3://<bucket>/<run>/multiqc/multiqc_report.html .

# 2. Set `project` in abc-app.yaml, then deploy
abc app validate
abc app deploy
abc app list
```

## Notes

- **100 MiB limit** on `content:`, checked before anything is uploaded. A MultiQC
  report is a few MB; a Quarto site with embedded data can approach it.
- **Content is addressed by sha256.** Redeploying an unchanged report uploads
  nothing. Three digests are retained per app, so a rollback to either of the
  previous two is a matter of pointing at that digest; older ones are pruned.
- **Requires** abc-cluster-cli with
  [PR #54](https://github.com/abc-cluster/abc-cluster-cli/pull/54), which adds
  both `framework: static` and `content:`.

## What this does not do

No interactivity, no live data, and no view of the platform's own record of the
run that produced the report. A dashboard over the cohort tables
(`tbstats/Statistics`, `tbstrains/Classification`, `tbgroups/*.matrix`) would
show more, and is scoped separately. It is not needed to support the claim this
example makes.
