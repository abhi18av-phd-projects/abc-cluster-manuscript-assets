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

## Deploy: fetch, check, then publish

The workflow is deliberately three steps, not two. The report comes out of the
object store to your own machine, you look at it, and only then does it go up.

```bash
# 1. Fetch the report the pipeline produced
abc data download s3://<bucket>/<run>/multiqc/multiqc_report.html .

# 2. Open it and confirm it is the report you meant to publish
open multiqc_report.html          # or: xdg-open / your browser

# 3. Set `project` in abc-app.yaml, then deploy
abc app validate
abc app deploy
abc app list
```

Step 2 is not ceremony. Deploying makes a result visible to everyone the app's
`access:` setting admits, and a MultiQC report carries sample identifiers in its
plots and its embedded data. Publishing the wrong run, or a run over the wrong
cohort, is a disclosure rather than a typo. The local copy is also the thing you
keep: `abc app deploy` uploads a digest, not a working file.

## Publishing straight from the bucket

The CLI accepts an object-store reference in `content:`:

```yaml
content: s3://nf-work/demo-results/multiqc/    # SUPPORTED, BUT SEE BELOW
```

Nothing is downloaded or re-uploaded; the generated job fetches that prefix
directly. **Do not use this form for a MultiQC report.** Two limitations apply,
and the second is the one that bites:

1. **No local check.** The point of the three-step workflow above is that a human
   sees the artefact before it is served. A bucket reference removes that step.

2. **It will not serve at `/`.** A local single-file `content:` is published as
   `index.html`, which is why `health: /` passes and the report appears at the
   app's root. Nothing renames a remote object. A prefix is fetched as it is
   stored, so a MultiQC run lands as `multiqc_report.html` alongside
   `multiqc_data/`, with no `index.html` anywhere. The platform's Caddy runs as
   `file-server` without `--browse`, so `GET /` returns 404, the health check
   never passes, and the app never reports healthy.

   The remote form is therefore only useful today for a prefix that already
   contains an `index.html` — a Quarto or MkDocs site, not a MultiQC report.

This is a gap in the CLI rather than a property of object storage: a single
remote object could be fetched to `index.html` the way a local one is. Until
that lands, the fetch-check-publish path above is the supported route, and it is
the one the manuscript reports.
