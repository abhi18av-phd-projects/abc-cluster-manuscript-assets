import * as pulumi from "@pulumi/pulumi";
import * as multipass from "@pulumi/multipass";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// abc-node single-node SYSTEMD variant
//
// Difference from single-node-single:
//   - MinIO, tusd run as systemd units; fx-tusd-hook as a Nomad job
//   - Nomad -dev is present for abc job run workloads + hook management
//   - Caddy HTTPS layer is optional (enableHttps=false by default)
//
// ⚠  SINGLE-USER ONLY.
//    This example uses Nomad in -dev mode, which disables the ACL system entirely.
//    All requests to the Nomad API (port 4646) are accepted regardless of the token
//    presented. Anyone with network access to the VM has full cluster control.
//    Appropriate for:
//      - Personal workstation / laptop evaluation (one user)
//      - Local developer testing of abc-cluster-cli commands
//      - H3ABioNet / workshop single-instructor setups where the VM is ephemeral
//    NOT appropriate for multi-user labs or shared infrastructure.
//    For multi-user setups use the single-node-multi/ example (Nomad server+client
//    with ACL enabled, per-user tokens, namespace isolation).
//
// Config:
//   pulumi config set enableHttps true           — adds Caddy HTTPS proxy + gen-tls-cert
//                                                   Nomad batch job (self-signed cert, IP SAN)
//   pulumi config set observability true         — adds VictoriaMetrics + VictoriaLogs +
//                                                   Grafana (with dashboard) + Alloy
//   pulumi config set enableApptainerDriver true — installs nomad-driver-apptainer;
//                                                   enables Apptainer/Singularity task driver
//
// External access points (once cloud-init completes):
//
//   HTTP mode (default, enableHttps=false):
//     MinIO S3        — http://<ip>:9000
//     MinIO Console   — http://<ip>:9001
//     tusd            — http://<ip>:1080/files/
//
//   HTTPS mode (enableHttps=true, self-signed cert — use -k or trust the cert):
//     MinIO S3 HTTPS  — https://<ip>:9443
//     MinIO Console   — https://<ip>:9444
//     tusd HTTPS      — https://<ip>:1443/files/
//
//   Always:
//     Nomad UI/API    — http://<ip>:4646     (dev mode, no TLS)
//     fx-tusd-hook    — http://<ip>:14002    (Nomad job; healthz at /healthz)
//
// When observability=true:
//   Grafana         — http://<ip>:3000     admin/admin  (abc-node Overview dashboard)
//   VictoriaMetrics — http://<ip>:8428
//   VictoriaLogs    — http://<ip>:9428
//   Alloy UI        — http://<ip>:12345

const config = new pulumi.Config();
const enableObservability      = config.getBoolean("observability")          ?? false;
const enableHttps              = config.getBoolean("enableHttps")            ?? false;
const enableApptainerDriver    = config.getBoolean("enableApptainerDriver")  ?? false;
// Default ON: without these a stock deployment cannot run the CLI's first job
// (node pool) or exercise lockfile runtimes (env tools). Set false to opt out.
const enableNodePool           = config.getBoolean("enableNodePool")         ?? true;
const enableEnvTools           = config.getBoolean("enableEnvTools")         ?? true;
const enableNextflow           = config.getBoolean("enableNextflow")         ?? true;

// Instance size. The old 2 CPU / 4G default runs nextflow-io/hello but cannot
// run an nf-core pipeline at all. Measured against nf-core/demo 1.2.0: a single
// FASTQC task requests Cores 2 / MemoryMB 12288, because nf-core's base.config
// gives process_low 12.GB. The Nextflow head reserves a further 2G. Anything
// below 16G leaves every worker stuck on
//     Placement Failure: Dimension "memory" exhausted on 1 nodes
// Note that capping this with a -c resourceLimits file does NOT help unless the
// file is readable INSIDE the head container; a path on the operator's
// workstation is silently ignored.
const vmCpus                   = config.getNumber("cpus")                    ?? 4;
const vmMemory                 = config.get("memory")                        ?? "16G";
const vmDisk                   = config.get("disk")                          ?? "20G";

// Merge two cloud-config YAML documents by concatenating their packages,
// write_files, and runcmd arrays. The #cloud-config header is re-added.
function mergeCloudInit(base: string, addon: string): string {
    type CloudConfig = Record<string, unknown[]>;
    const b = yaml.load(base) as CloudConfig;
    const a = yaml.load(addon) as CloudConfig;
    const merged: CloudConfig = { ...b };
    // bootcmd matters: anything an addon needs to exist BEFORE write_files or
    // runcmd (a host_volume path, for instance) has to be created there, and
    // omitting it here drops those entries silently.
    for (const key of ["packages", "bootcmd", "write_files", "runcmd"]) {
        if (a[key]) {
            merged[key] = [...(merged[key] ?? []), ...a[key]];
        }
    }
    return "#cloud-config\n" + yaml.dump(merged);
}

let cloudinit = fs.readFileSync(
    path.join(__dirname, "cloud-init", "base.yaml"),
    "utf8"
);

if (enableHttps) {
    const httpsAddon = fs.readFileSync(
        path.join(__dirname, "cloud-init", "https-addon.yaml"),
        "utf8"
    );
    cloudinit = mergeCloudInit(cloudinit, httpsAddon);
}

if (enableObservability) {
    const obsAddon = fs.readFileSync(
        path.join(__dirname, "cloud-init", "obs-addon.yaml"),
        "utf8"
    );
    cloudinit = mergeCloudInit(cloudinit, obsAddon);
}

// Align the client's node pool with the CLI's default target, and pin the
// platform's own job to the same pool so both agree on where work runs.
if (enableNodePool) {
    for (const f of ["node-pool-addon.yaml", "fx-tusd-hook-addon.yaml"]) {
        cloudinit = mergeCloudInit(
            cloudinit,
            fs.readFileSync(path.join(__dirname, "cloud-init", f), "utf8")
        );
    }
}

// pixi + micromamba on the host and published into MinIO, so the CLI's
// --runtime=pixi / --runtime=micromamba directives resolve.
if (enableEnvTools) {
    cloudinit = mergeCloudInit(
        cloudinit,
        fs.readFileSync(path.join(__dirname, "cloud-init", "env-tools-addon.yaml"), "utf8")
    );
}

// Host volumes and s5cmd that 'abc pipeline run' requires on both the head
// and every nf-nomad worker. Without them no pipeline task can be placed.
if (enableNextflow) {
    cloudinit = mergeCloudInit(
        cloudinit,
        fs.readFileSync(path.join(__dirname, "cloud-init", "nextflow-volumes-addon.yaml"), "utf8")
    );
}

if (enableApptainerDriver) {
    const apptainerAddon = fs.readFileSync(
        path.join(__dirname, "cloud-init", "apptainer-driver-addon.yaml"),
        "utf8"
    );
    cloudinit = mergeCloudInit(cloudinit, apptainerAddon);
}

const abcNode = new multipass.resources.Instance("abc-node", {
    name: "abc-node",
    image: "24.04",
    cpus: vmCpus,
    memory: vmMemory,
    disk: vmDisk,
    cloudinit,
});

// Snapshot after services are installed (cloud-init done) for fast resets.
const snapshotComment = (() => {
    const parts = ["MinIO + tusd (systemd)", "fx-tusd-hook (Nomad)", "Nomad -dev"];
    if (enableHttps)             parts.push("Caddy HTTPS");
    if (enableObservability)     parts.push("obs stack");
    if (enableApptainerDriver)   parts.push("Apptainer driver");
    return parts.join(" + ");
})();

const postInitSnapshot = new multipass.resources.Snapshot("abc-node-post-init", {
    instanceName: abcNode.name,
    snapshotName: "post-init",
    comment: snapshotComment,
}, { dependsOn: [abcNode] });

export const instanceName  = abcNode.name;
export const ipv4          = abcNode.ipv4;
export const nomadAddr     = pulumi.interpolate`http://${abcNode.ipv4}:4646`;
export const fxTusdHookAddr = pulumi.interpolate`http://${abcNode.ipv4}:14002`;
export const httpsEnabled  = pulumi.output(enableHttps);

// Storage access points: HTTPS when enableHttps=true, plain HTTP otherwise.
export const minioS3      = enableHttps
    ? pulumi.interpolate`https://${abcNode.ipv4}:9443`
    : pulumi.interpolate`http://${abcNode.ipv4}:9000`;
export const minioConsole = enableHttps
    ? pulumi.interpolate`https://${abcNode.ipv4}:9444`
    : pulumi.interpolate`http://${abcNode.ipv4}:9001`;
export const toolsEndpoint = enableEnvTools
    ? pulumi.interpolate`http://${abcNode.ipv4}:9000`
    : "(set enableEnvTools=true to enable)";
export const nodePool = enableNodePool ? "compute" : "default";
export const instanceSize = pulumi.interpolate`${vmCpus} vCPU / ${vmMemory} / ${vmDisk}`;
export const tusdAddr     = enableHttps
    ? pulumi.interpolate`https://${abcNode.ipv4}:1443`
    : pulumi.interpolate`http://${abcNode.ipv4}:1080`;
export const snapshotName          = postInitSnapshot.snapshotName;
export const obsEnabled            = enableObservability;
export const apptainerDriverEnabled = enableApptainerDriver;

// Observability access points (only meaningful when observability=true)
export const grafanaAddr     = enableObservability
    ? pulumi.interpolate`http://${abcNode.ipv4}:3000`
    : pulumi.output("(set observability=true to enable)");
export const victoriaMetrics = enableObservability
    ? pulumi.interpolate`http://${abcNode.ipv4}:8428`
    : pulumi.output("(set observability=true to enable)");
export const victoriaLogs    = enableObservability
    ? pulumi.interpolate`http://${abcNode.ipv4}:9428`
    : pulumi.output("(set observability=true to enable)");
// VictoriaTraces: OTLP HTTP at /insert/opentelemetry/v1/traces; no Grafana plugin yet (v0.8.x pre-release)
export const victoriaTraces  = enableObservability
    ? pulumi.interpolate`http://${abcNode.ipv4}:10428`
    : pulumi.output("(set observability=true to enable)");
export const otlpEndpoint    = enableObservability
    ? pulumi.interpolate`http://${abcNode.ipv4}:4318`
    : pulumi.output("(set observability=true to enable)");
export const alloyUI          = enableObservability
    ? pulumi.interpolate`http://${abcNode.ipv4}:12345`
    : pulumi.output("(set observability=true to enable)");

// A ready-to-import CLI context for this deployment. The CLI is configured by
// importing a context file rather than by assembling one flag at a time, so
// write this out and import it:
//
//   pulumi stack output abcContext --show-secrets > abc-context.yaml
//   abc auth context add lab --from-file ./abc-context.yaml
//
// The credentials below are the template's built-in development defaults. They
// are not secrets, and this deployment is not intended to be reachable beyond
// the host running it.
export const abcContext = pulumi.interpolate`version: "1.0"
active_context: lab
contexts:
  lab:
    access_token: none
    endpoint: http://${abcNode.ipv4}:4646
    upload_endpoint: http://${abcNode.ipv4}:1080/files/
    admin:
      services:
        nomad:
          addr: http://${abcNode.ipv4}:4646
          # Without these the CLI falls back to build-time defaults —
          # "platform" for a pipeline head, "default" for an app — and neither
          # pool exists on a single node, so every submission fails placement
          # until --head-pool / --node-pool are discovered.
          head_pool: compute
          worker_pool: compute
        minio:
          access_key: minioadmin
          secret_key: minioadmin
          cred_source:
            local:
              endpoint: http://${abcNode.ipv4}:9000
              http: http://${abcNode.ipv4}:9001
              user: minioadmin
              password: minioadmin
      tools:
        endpoint: http://${abcNode.ipv4}:9000
`;
