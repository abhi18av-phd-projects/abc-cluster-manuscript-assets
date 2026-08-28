# mtbseq-90-multiqc

The MultiQC report from the 90-sample MTBseq-nf run, deployed as a static app.

This is the manuscript's data-app example. It exists to show one thing: that a
result produced by a pipeline on the platform can be published from the same
platform, with one command and no application code.

## Why static

ADR-0062 treats the static asset app as the preferred runtime shape — no
application process, nothing to keep alive, strongest sovereignty. MultiQC emits
a single self-contained HTML file with its data inlined, so it needs no server
logic, no data connection and no session. Anything more would be a worse
demonstration of the same claim.

## Deploy

```bash
# 1. Fetch the report the pipeline produced
abc data download s3://<bucket>/<run>/multiqc/multiqc_report.html .

# 2. Build and push
docker build -t <registry>/mtbseq-90-multiqc:1.0 .
docker push  <registry>/mtbseq-90-multiqc:1.0

# 3. Edit abc-app.yaml (project, image), then deploy
abc app validate
abc app deploy
abc app list
```

## Requirements

`framework: static` needs abc-cluster-cli with
[PR #54](https://github.com/abc-cluster/abc-cluster-cli/pull/54). Until that
merges, `framework: custom` with the same `port` and `health` behaves
identically — `static` exists to make the intent explicit and the defaults
correct, not to change what runs.

## What this does not do

No interactivity, no live data, no view of the platform's own record of the run
that produced the report. A dashboard over the cohort tables
(`tbstats/Statistics`, `tbstrains/Classification`, `tbgroups/*.matrix`) would
show more, and is scoped separately. It is not needed to support the claim this
example makes.
