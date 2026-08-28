# MultiQC report for the 90-sample MTBseq-nf run, served as a static app.
#
# nginx-unprivileged listens on 0.0.0.0:8080 as a non-root user, which is the
# platform's bind contract, so nothing here edits nginx.conf or runs as root.
#
# MultiQC emits a single self-contained HTML file with its data inlined, so
# there is nothing to fetch at runtime and no application process to keep alive.
FROM nginxinc/nginx-unprivileged:alpine

# Fetch the report from the run's results prefix before building, e.g.
#   abc data download s3://<bucket>/<run>/multiqc/multiqc_report.html .
COPY multiqc_report.html /usr/share/nginx/html/index.html

EXPOSE 8080
