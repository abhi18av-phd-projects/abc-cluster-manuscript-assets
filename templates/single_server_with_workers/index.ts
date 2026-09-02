import * as pulumi from "@pulumi/pulumi";
import * as multipass from "@incsteps/pulumi-multipass";
import * as command from "@pulumi/command";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ── Userspace types ──────────────────────────────────────────────────────────
// A "group" is a research group / lab / project — one Nomad namespace + one
// MinIO bucket + N members. Each member gets a Nomad ACL token and a MinIO
// service account scoped to their prefix within the bucket.
// See ADR-0053 §2 and brainstorms/abc-cluster/2026-05-12-...md §5.
interface Member {
    username: string;
    role: "admin" | "user";  // admin → group-admin-<g> policy; user → member-<g>
}
interface Group {
    name: string;       // becomes the Nomad namespace and MinIO bucket name
    namespace?: string; // defaults to name
    bucket?: string;    // defaults to name
    members: Member[];
}

// abc-node multi-node: single_server_with_clients topology (ADR-0029).
//
// Provisions two types of VMs:
//   abc-server  — Nomad server agent, ACL enabled, no workloads
//   abc-worker-N — Nomad client agent(s), all task drivers, workloads run here
//
// Unlike single-node-server-worker (which uses `nomad agent -dev`), this topology uses
// real server+client agents with persistent Raft state and ACL enforcement.
// State survives Nomad restarts. All API calls require an ACL token.
//
// ACL bootstrap:
//   The server cloud-init runs nomad-acl-bootstrap.service which waits for the
//   Nomad leader to be elected, then generates the initial management token and
//   writes it to /etc/nomad-bootstrap-token (root:root, mode 0600).
//   Retrieve it after `pulumi up` with:
//     multipass exec abc-server -- sudo cat /etc/nomad-bootstrap-token
//
// Configure abc-cluster-cli to use this cluster:
//   abc auth context add single-server-with-workers \
//     --cluster-type abc-nodes \
//     --nomad-addr http://<server-ip>:4646 \
//     --nomad-token <bootstrap-token>
//   abc auth context use single-server-with-workers
//
// Config options:
//   pulumi config set clientCount 2      [default: 1]  — number of client VMs
//   pulumi config set serverCpus 2       [default: 2]  — server VM CPUs
//   pulumi config set serverMemory 2G    [default: 2G] — server VM memory
//   pulumi config set serverDisk 10G     [default: 10G]— server VM disk
//   pulumi config set clientCpus 2       [default: 2]  — client VM CPUs each
//   pulumi config set clientMemory 4G    [default: 4G] — client VM memory each
//   pulumi config set clientDisk 20G     [default: 20G]— client VM disk each
//
// Ports (server VM):
//   4646 — Nomad HTTP API (ACL-protected)
//   4647 — Nomad RPC (internal, client→server)
//   4648 — Nomad Serf/gossip (internal, cluster membership)
//
// After provisioning:
//   nomad status requires NOMAD_TOKEN or -token flag (ACL is enabled).
//   Use `abc admin services cli nomad -- node status` with context configured.

const config = new pulumi.Config();
const clientCount  = config.getNumber("clientCount")   ?? 1;
const serverCpus   = config.getNumber("serverCpus")    ?? 2;
const serverMemory = config.get("serverMemory")        ?? "2G";
const serverDisk   = config.get("serverDisk")          ?? "10G";
const clientCpus   = config.getNumber("clientCpus")    ?? 2;
const clientMemory = config.get("clientMemory")        ?? "4G";
const clientDisk   = config.get("clientDisk")          ?? "20G";

// Default group: a sample SU MBHG Bioinformatics group with two members,
// matching the brainstorm's example. Override in Pulumi.<stack>.yaml under
// the `single-server-with-workers:groups` key.
const defaultGroups: Group[] = [{
    name: "su-mbhg-bioinformatics",
    namespace: "su-mbhg-bioinformatics",
    bucket: "su-mbhg-bioinformatics",
    members: [
        { username: "abhi", role: "admin" },
        { username: "kim",  role: "user"  },
    ],
}];
const groups = config.getObject<Group[]>("groups") ?? defaultGroups;

// MinIO admin credentials — these come from the static MINIO_ROOT_USER /
// MINIO_ROOT_PASSWORD in nomad-jobs/minio.nomad.hcl. The userspace provisioner
// uses them to create per-user service accounts (which become the credentials
// researchers actually use).
const minioRootUser     = config.get("minioRootUser")     ?? "minioadmin";
const minioRootPassword = config.getSecret("minioRootPassword") ?? pulumi.secret("minioadmin");

// ── Utility: merge two cloud-config YAML documents ────────────────────────────
// Concatenates packages, write_files, and runcmd arrays from two cloud-init
// fragments. The second document (addon) is appended to the first (base).
function mergeCloudInit(base: string, addon: string): string {
    type CloudConfig = Record<string, unknown[]>;
    const b = yaml.load(base) as CloudConfig;
    const a = yaml.load(addon) as CloudConfig;
    const merged: CloudConfig = { ...b };
    // bootcmd matters: anything a later stage needs must exist before write_files.
    for (const key of ["packages", "bootcmd", "write_files", "runcmd"]) {
        if (a[key]) {
            merged[key] = [...(merged[key] ?? []), ...a[key]];
        }
    }
    // cloud-init silently discards a runcmd entry that is not a string, and an
    // unquoted colon in a YAML scalar turns it into a mapping. That failure is
    // invisible: the instance boots, the schema check warns, and the commands
    // simply never run. Fail loudly here instead.
    for (const key of ["runcmd", "bootcmd"]) {
        for (const entry of (merged[key] ?? [])) {
            if (typeof entry !== "string" && !Array.isArray(entry)) {
                throw new Error(
                    `cloud-init ${key} entry is ${typeof entry}, not a string — ` +
                    `quote it (an unquoted ':' makes YAML parse it as a mapping): ` +
                    JSON.stringify(entry),
                );
            }
        }
    }
    return "#cloud-config\n" + yaml.dump(merged);
}

// ── Server VM ─────────────────────────────────────────────────────────────────
// Nomad server agent: ACL enabled, bootstrap_expect=1, no workload tasks.
// ACL bootstrap token generated by nomad-acl-bootstrap.service (see cloud-init).
// Interactive workbench (JupyterHub + PocketBase + abc-auth-svc). On by
// default here because access control is enabled in this topology, which is
// what gives the broker per-user tokens to issue. Disable with
// `pulumi config set enableWorkbench false` to save ~3 minutes of provisioning.
const enableWorkbench = config.getBoolean("enableWorkbench") ?? true;

let serverCloudinit = fs.readFileSync(
    path.join(__dirname, "cloud-init", "nomad-server.yaml"),
    "utf8"
);
if (enableWorkbench) {
    serverCloudinit = mergeCloudInit(
        serverCloudinit,
        fs.readFileSync(path.join(__dirname, "cloud-init", "workbench-addon.yaml"), "utf8"),
    );
}

const serverNode = new multipass.resources.Instance("abc-server", {
    name: "abc-server",
    image: "24.04",
    cpus: serverCpus,
    memory: serverMemory,
    disk: serverDisk,
    cloudinit: serverCloudinit,
}, {
    // deleteBeforeReplace: Multipass VM names are resource IDs — a VM with the same
    // name cannot be created while the old one exists. Without this flag, Pulumi's
    // default create-before-delete order adopts the old VM then deletes it as the
    // "original", causing the VM to disappear. With delete-before-replace, the old
    // VM is deleted first, then the new one is created with no name collision.
    deleteBeforeReplace: true,
});

// Post-init snapshot of the server — captures Nomad server + ACL bootstrap state.
// Restoring from this snapshot gives a clean server without re-running cloud-init
// (note: ACL bootstrap state is NOT preserved across snapshot restores because
// Nomad Raft state is stored in /opt/nomad/data which IS part of the snapshot).
const serverPostInitSnapshot = new multipass.resources.Snapshot("abc-server-post-init", {
    instanceName: serverNode.name,
    snapshotName: "post-init",
    comment: "Nomad server agent + ACL bootstrap — single-server control plane baseline",
}, { dependsOn: [serverNode], deleteBeforeReplace: true });

// ── Client VMs ────────────────────────────────────────────────────────────────
// Each client runs all task drivers (docker, podman, raw_exec, java, apptainer).
// The server IP is injected into /etc/nomad.d/client-join.hcl at provision time
// via pulumi.interpolate — clients are only created after the server IP is known.

const clientBase = fs.readFileSync(
    path.join(__dirname, "cloud-init", "nomad-client-base.yaml"),
    "utf8"
);

// Build client cloud-init: merge base with a dynamically generated fragment
// that writes /etc/nomad.d/client-join.hcl containing the server's IP.
// This file is loaded by the Nomad agent alongside client-base.hcl (Nomad
// merges all *.hcl files in the config directory alphabetically).
function makeClientCloudinit(serverName: pulumi.Output<string>): pulumi.Output<string> {
    return serverName.apply(host => {
        // This fragment is merged into the base cloud-init.
        // It writes two files and adds a runcmd — all require the server IP:
        //
        // The server is addressed by its multipass DNS name, never by IP.
        // Baking the IP made every server replacement orphan the workers: their
        // retry_join still pointed at the old address, so no client registered
        // and the cluster came up with zero nodes. Multipass resolves the name
        // to the server's current address, so replacing the server is safe.
        //
        // 1. /etc/nomad.d/client-join.hcl — Nomad RPC join address.
        //    Port 4647 is the Nomad RPC port — what clients use to reach the server.
        //    Port 4648 is Serf (server-to-server gossip only). Using 4648 causes
        //    "rpc error: EOF" because Serf doesn't speak the Nomad RPC protocol.
        //
        // 2. /etc/fstab (append) — NFS mount for /opt/nf-work.
        //    The server exports /opt/nf-work; the client mounts it at the same path
        //    so Nextflow (running on the server) and Docker task containers (running
        //    on the client) see the same shared workDir without rclone.
        //    _netdev: defer mount until network is up (systemd dependency).
        //    nofail: don't block boot if NFS is temporarily unavailable.
        //
        // 3. runcmd — attempt NFS mount during cloud-init with a retry loop.
        //    The server cloud-init may still be running when this client provisions.
        //    30 attempts × 10s = 5 min max wait. Falls back gracefully — fstab
        //    _netdev entry ensures systemd mounts it on the next boot if needed.
        const joinFragment = `#cloud-config
write_files:
  - path: /etc/nomad.d/client-join.hcl
    content: |
      client {
        server_join {
          retry_join     = ["${host}:4647"]
          retry_interval = "5s"
          retry_max      = 0
        }
      }
  - path: /etc/fstab
    append: true
    content: |
      ${host}:/opt/nf-work  /opt/nf-work  nfs4  defaults,_netdev,nofail  0  0
runcmd:
  # Backgrounded on purpose. This retried for up to five minutes on the boot
  # path, and nomad-client-nf-setup then blocked for up to ten more waiting on
  # a token published over that mount. Together they pushed cloud-init past the
  # provider's fixed 900s launch budget, so healthy workers were recorded as
  # failed. Neither is needed for the client to register with Nomad, and the
  # fstab _netdev entry mounts it regardless.
  - "nohup sh -c 'for i in $(seq 1 30); do mount -t nfs4 ${host}:/opt/nf-work /opt/nf-work 2>/dev/null && break; sleep 10; done' >/var/log/abc-nfs-mount.log 2>&1 &"
`;
        return mergeCloudInit(clientBase, joinFragment);
    });
}

const clientNodes: multipass.resources.Instance[] = [];
const clientSnapshots: multipass.resources.Snapshot[] = [];

for (let i = 0; i < clientCount; i++) {
    const name = `abc-worker-${i}`;
    const clientCloudinit = makeClientCloudinit(serverNode.name);

    const clientNode = new multipass.resources.Instance(name, {
        name,
        image: "24.04",
        cpus: clientCpus,
        memory: clientMemory,
        disk: clientDisk,
        cloudinit: clientCloudinit,
    }, {
        // Clients are created after the server so that the server IP is known.
        // They also implicitly depend on the server being up before they try to
        // join — though the retry_join loop handles timing automatically.
        dependsOn: [serverNode],
        // See server node comment: name-as-ID requires delete-before-replace.
        deleteBeforeReplace: true,
    });

    const clientSnapshot = new multipass.resources.Snapshot(`${name}-post-init`, {
        instanceName: clientNode.name,
        snapshotName: "post-init",
        comment: `Nomad client agent + runtimes (docker/podman/apptainer/java) — joined to abc-server`,
    }, { dependsOn: [clientNode], deleteBeforeReplace: true });

    clientNodes.push(clientNode);
    clientSnapshots.push(clientSnapshot);
}

// ── Userspace + auth gateway layer ────────────────────────────────────────────
// Phases 0 + 1 of ADR-0053: Traefik, forward-auth, and per-group userspace
// (Nomad namespaces, MinIO buckets, per-user ACL tokens, per-user MinIO service
// accounts). All operations run as `multipass exec abc-server -- …`
// against the server VM, which holds the bootstrap token and has both `nomad`
// and `mc` installed. Everything depends on cloud-init having finished —
// we gate on a single "bootstrap-ready" command that waits for the bootstrap
// token file AND the base-policies service.
//
// Design note (most important architectural decision):
//   We provision userspace via `multipass exec` + `command.local.Command`
//   rather than via a Pulumi Nomad provider. Two reasons:
//     1. The bootstrap token only exists *after* cloud-init runs, and
//        Pulumi providers want credentials at program-evaluation time, not
//        at apply time. Reading the token mid-graph requires the same
//        local-exec dance anyway.
//     2. It keeps the provider footprint to one (multipass) for the local
//        seedling, simplifying onboarding. single-server-with-workers / abc-node-
//        prod can swap in a real Nomad provider later if they grow many groups,
//        but the seedling never has more than ~10 — local commands are fine.
//   The trade-off: tokens are surfaced via `pulumi stack output --show-secrets`
//   rather than being first-class Pulumi-managed resources. Acceptable for the
//   operator-issued model; signup-svc handles the self-service path.

const client0 = clientNodes[0];

// Single gating command: blocks until the bootstrap token file is non-empty
// AND the admin-full base policy has been applied. All downstream userspace
// commands depend on this. We re-run it on every `pulumi up` (triggers via
// timestamp) — Nomad commands are idempotent so this is cheap.
// Every command below runs *inside* the server VM, so its effect lives and dies
// with that instance. Pulumi will not re-run a command whose inputs are
// unchanged, which meant a replaced server silently kept commands marked as
// satisfied while their side effects were gone. copy-auth-jobs stages job HCLs
// into /tmp on the server; after a replacement they no longer existed and
// deploy-forward-auth failed with:
//   Error getting jobfile from "/tmp/abc-forward-auth.nomad.hcl": no such file
// Including the server's identity in each command's triggers ties them to the
// instance they act on, so replacing the server re-runs them.
const serverIdentity = pulumi.interpolate`${serverNode.name}:${serverNode.ipv4}`;

const bootstrapReady = new command.local.Command("nomad-bootstrap-ready", {
    create: pulumi.interpolate`
        set -e
        for i in $(seq 1 90); do
          if multipass exec abc-server -- sudo test -s /etc/nomad-bootstrap-token; then
            if multipass exec abc-server -- systemctl is-active --quiet nomad-apply-base-policies; then
              echo "bootstrap-ready"; exit 0
            fi
          fi
          sleep 5
        done
        echo "bootstrap not ready after 7.5min" >&2; exit 1
    `,
}, {
    // Depend on the SNAPSHOTS, not just the instances. Multipass stops an
    // instance to snapshot it, so snapshotting raced every server-side command
    // below: exec failed while the VM was down, and the restore cleared /tmp,
    // discarding the job HCLs that copy-auth-jobs had staged there. That
    // produced two failures that looked unrelated —
    //   Error getting jobfile from "/tmp/abc-forward-auth.nomad.hcl": no such file
    //   deploy-minio: exit status 1
    // Waiting for the snapshots serialises this properly.
    dependsOn: [serverNode, ...clientNodes, serverPostInitSnapshot, ...clientSnapshots],
});

// Helper that returns the bash prefix for running a `nomad …` command on the
// server VM with NOMAD_TOKEN exported. Used inline by every userspace command.
const nomadExecPrefix = `multipass exec abc-server -- sudo bash -c '
  export NOMAD_ADDR=http://127.0.0.1:4646
  export NOMAD_TOKEN=$(awk "/^Secret ID/ { print \\$NF }" /etc/nomad-bootstrap-token)`;

// ── Nomad namespaces ────────────────────────────────────────────────────────
// Prod runs platform services in a dedicated `abc-reserved` namespace and
// researcher jobs in per-group namespaces. The per-group namespaces are
// applied in the per-group loop below; the platform-reserved namespace is
// created here because the platform job specs (minio, abc-tusd,
// abc-forward-auth) all carry `namespace = "abc-reserved"` and will fail to
// register until it exists. Idempotent — re-run safely on every `pulumi up`.
const reservedNamespace = new command.local.Command("nomad-reserved-namespace", {
    create: pulumi.interpolate`${nomadExecPrefix}
      nomad namespace apply -description "ABC platform-reserved services + tooling" abc-reserved
    '`,
    delete: pulumi.interpolate`${nomadExecPrefix}
      nomad namespace delete abc-reserved || true
    '`,
    triggers: [serverIdentity],
}, { dependsOn: [bootstrapReady] });

// ── Deploy Traefik + forward-auth Nomad jobs ────────────────────────────────
// The job HCLs live in nomad-jobs/. We copy them onto the server VM and run
// `nomad job run`. The forward-auth job's NOMAD_ADDR is templated with the
// server's IP so the in-host loopback reaches the right place.

// `abc app deploy` submits into the abc-apps namespace. Without it the first
// app deployment fails with:
//   job "app-..." is in nonexistent namespace "abc-apps"
// The single-node template learned the same lesson; here the server keeps its
// state across restarts, so applying it once at provision time is enough.
const appsNamespace = new command.local.Command("nomad-apps-namespace", {
    create: pulumi.interpolate`${nomadExecPrefix}
      nomad namespace apply -description "Scientific web apps deployed with abc app" abc-apps
    '`,
    delete: pulumi.interpolate`${nomadExecPrefix}
      nomad namespace delete abc-apps || true
    '`,
    triggers: [serverIdentity],
}, { dependsOn: [bootstrapReady] });

const copyAuthJobs = new command.local.Command("copy-auth-jobs", {
    create: `
        set -e
        multipass transfer ${path.join(__dirname, "nomad-jobs", "abc-traefik.nomad.hcl")} \\
          abc-server:/tmp/abc-traefik.nomad.hcl
        multipass transfer ${path.join(__dirname, "nomad-jobs", "abc-forward-auth.nomad.hcl")} \\
          abc-server:/tmp/abc-forward-auth.nomad.hcl
    `,
    triggers: [serverIdentity, 
        fs.readFileSync(path.join(__dirname, "nomad-jobs", "abc-traefik.nomad.hcl"), "utf8"),
        fs.readFileSync(path.join(__dirname, "nomad-jobs", "abc-forward-auth.nomad.hcl"), "utf8"),
    ],
}, { dependsOn: [bootstrapReady] });

// forward-auth needs to know how to reach the Nomad API. We sed the
// ${NOMAD_ADDR_OVERRIDE} placeholder before submission.
const deployForwardAuth = new command.local.Command("deploy-forward-auth", {
    create: pulumi.interpolate`${nomadExecPrefix}
      sed -i "s|\\$\{NOMAD_ADDR_OVERRIDE\}|http://${serverNode.ipv4}:4646|g" /tmp/abc-forward-auth.nomad.hcl
      nomad job run /tmp/abc-forward-auth.nomad.hcl
    '`,
    triggers: [serverIdentity],
}, { dependsOn: [copyAuthJobs, reservedNamespace] });

// ── Workbench services ──────────────────────────────────────────────────────
// The three workbench components are installed by cloud-init but cannot be
// configured there: they need the ACL bootstrap token and the real endpoints,
// which only exist after the cluster is up. Write them now, then start.
const workbenchEnv = enableWorkbench ? new command.local.Command("workbench-env", {
    create: pulumi.interpolate`
        multipass exec abc-server -- sudo bash -c 'TOKEN=$(awk "/^Secret ID/ { print \$NF }" /etc/nomad-bootstrap-token 2>/dev/null)
cat > /etc/abc/workbench-cluster.env <<EOF
ABC_AUTH_LISTEN=0.0.0.0:4182
ABC_AUTH_LOG_LEVEL=info
NOMAD_ADDR=http://${serverNode.ipv4}:4646
NOMAD_TOKEN=\${TOKEN}
JUPYTERHUB_API_URL=http://127.0.0.1:15001/hub/api
HUB_PUBLIC_URL=http://${serverNode.ipv4}:15000
CLUSTER_NAME=abc-cluster
CLUSTER_DATACENTER=dc1
CLUSTER_HEAD_POOL=platform
CLUSTER_WORKER_POOL=compute
CLUSTER_NOMAD_ENDPOINT=http://${serverNode.ipv4}:4646
CLUSTER_MINIO_ENDPOINT=http://${client0.ipv4}:9000
CLUSTER_UPLOAD_ENDPOINT=http://${client0.ipv4}:1080/files/
CLUSTER_AUTH_ENDPOINT=http://${serverNode.ipv4}:4182
MINIO_CONSOLE_URL=http://${client0.ipv4}:9001
COOKIE_SECURE=false
EOF
chmod 0640 /etc/abc/workbench-cluster.env'
    `,
}, { dependsOn: [bootstrapReady] }) : undefined;

const workbenchUp = enableWorkbench ? new command.local.Command("workbench-up", {
    create: `
        multipass exec abc-server -- sudo bash -c '
          # Trigger the install now that every instance is up. Running it on the
          # boot path starved concurrently launching workers.
          systemctl start abc-workbench-install.service || true
          for i in $(seq 1 160); do
            [ -f /var/lib/abc-workbench-installed ] && break
            sleep 15
          done
          /usr/local/bin/abc-workbench-status
          systemctl daemon-reload
          systemctl enable --now jupyterhub.service   >/dev/null 2>&1
          systemctl enable --now abc-auth-svc.service >/dev/null 2>&1
          sleep 8
          for u in abc-pocketbase jupyterhub abc-auth-svc; do
            printf "  %-16s %s\\n" "$u" "$(systemctl is-active $u)"
          done
          curl -sf http://127.0.0.1:4182/healthz >/dev/null && echo "  auth-svc healthz OK" || echo "  auth-svc healthz FAILED"
        '
    `,
}, { dependsOn: workbenchEnv ? [workbenchEnv] : [] }) : undefined;

const deployTraefik = new command.local.Command("deploy-traefik", {
    create: pulumi.interpolate`${nomadExecPrefix}
      nomad job run /tmp/abc-traefik.nomad.hcl
    '`,
    triggers: [serverIdentity],
}, { dependsOn: [deployForwardAuth] });

// ── Deploy MinIO (also needed by userspace bucket provisioning) ─────────────
// MinIO is already part of the single-server-with-workers job set (nomad-jobs/minio.nomad.hcl)
// but until now it was deployed manually. With userspace provisioning relying
// on it, we deploy it here so `pulumi up` produces a complete stack.
const deployMinio = new command.local.Command("deploy-minio", {
    create: pulumi.interpolate`
        multipass transfer ${path.join(__dirname, "nomad-jobs", "minio.nomad.hcl")} \\
          abc-server:/tmp/minio.nomad.hcl
        ${nomadExecPrefix}
          nomad job run /tmp/minio.nomad.hcl
        '
    `,
    triggers: [serverIdentity, fs.readFileSync(path.join(__dirname, "nomad-jobs", "minio.nomad.hcl"), "utf8")],
}, { dependsOn: [bootstrapReady, reservedNamespace] });

// Wait for MinIO to be healthy and configure the `mc` alias on the server,
// then we can run admin commands against it.
const minioReady = new command.local.Command("minio-ready", {
    create: pulumi.interpolate`
        multipass exec abc-server -- bash -c '
          for i in $(seq 1 60); do
            curl -sf http://${client0.ipv4}:9000/minio/health/live && break
            sleep 5
          done
          mc alias set abc http://${client0.ipv4}:9000 ${minioRootUser} "$(cat <<"PWEOF"
${minioRootPassword}
PWEOF
)" >/dev/null
        '
    `,
}, { dependsOn: [deployMinio] });

// ── Platform MinIO provisioning (scoped tusd creds + platform buckets) ──────
// Prod stopped using the MinIO root user for tusd. It created a MinIO policy
// `abc-tusd-rw` and a service user `abc-tusd-svc` bound to it, and tusd reads
// the creds from the Nomad Variable `nomad/jobs/abc-tusd`. We mirror that here.
//
// The root creds (minioadmin/minioadmin in minio.nomad.hcl) stay ONLY for
// MinIO's own bootstrap/admin — the `mc` alias above uses them to *create*
// the scoped user; no service ever consumes root.
//
// Sim note: because the seedling is throwaway, we use a deterministic dev
// secret for abc-tusd-svc rather than a generated one. It is still a scoped,
// non-root user (policy abc-tusd-rw), exactly as prod requires.
const tusdSvcAccessKey = "abc-tusd-svc";
const tusdSvcSecretKey = "abc-tusd-svc-dev-secret";

// Platform buckets: tusd-uploads + abc-reserved + one bucket per group. The
// per-group bucket name follows the scaffold's existing convention (the
// group's `bucket` field, default = group name) — we do NOT introduce prod's
// `su-` prefix; the sim's group list already uses its own naming.
const platformBuckets = ["tusd-uploads", "abc-reserved"];
const groupBuckets = groups.map(g => g.bucket ?? g.name);
const allPlatformBuckets = [...platformBuckets, ...groupBuckets];

// Publish the software-environment runtimes to the cluster tools endpoint.
//
// `abc job run --runtime=pixi|micromamba` does NOT use a runtime installed on
// the node. The CLI generates a wrapper that downloads it from the tools
// endpoint into the task directory at execution time, so the binary has to
// exist in object storage or the job dies with:
//   curl: (22) The requested URL returned error: 403
//   [abc] micromamba download failed
//
// `abc admin tools push` publishes only s5cmd, so these two are uploaded here.
// The CLI normalises the architecture before building the URL, so the object
// names must use amd64/arm64 rather than uname's x86_64/aarch64 — otherwise the
// task 404s instead.
const publishEnvTools = new command.local.Command("minio-publish-env-tools", {
    create: pulumi.interpolate`
        multipass exec abc-server -- bash -c '
          set -e
          PIXI_VERSION=v0.41.4
          mkdir -p /tmp/abc-envtools
          curl -fsSL -o /tmp/abc-envtools/pixi \
            "https://github.com/prefix-dev/pixi/releases/download/\${PIXI_VERSION}/pixi-x86_64-unknown-linux-musl" \
            || echo "WARNING: pixi download failed; --runtime=pixi will not work" >&2
          # Direct binary, not the .tar.bz2 release: the base image ships no
          # bzip2, so tar cannot decompress it.
          curl -fsSL -o /tmp/abc-envtools/micromamba \
            "https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-linux-64" \
            || echo "WARNING: micromamba download failed; --runtime=micromamba will not work" >&2

          mc mb --ignore-existing abc/abc-reserved
          mc anonymous set download abc/abc-reserved

          K=$(uname -s | tr "[:upper:]" "[:lower:]")
          A=$(uname -m); case "$A" in x86_64) A=amd64 ;; aarch64) A=arm64 ;; esac
          for t in pixi micromamba; do
            if [ -s "/tmp/abc-envtools/$t" ]; then
              chmod +x "/tmp/abc-envtools/$t"
              mc cp "/tmp/abc-envtools/$t" "abc/abc-reserved/binary_tools/$t-$K-$A" \
                && echo "published $t-$K-$A"
            fi
          done
          rm -rf /tmp/abc-envtools
        '
    `,
    triggers: [serverIdentity],
}, { dependsOn: [minioReady] });

const minioTusdProvision = new command.local.Command("minio-tusd-provision", {
    create: pulumi.interpolate`
        multipass exec abc-server -- bash -c '
          set -e
          # Auto-create platform + per-group buckets (idempotent).
          for b in ${allPlatformBuckets.join(" ")}; do
            mc mb --ignore-existing abc/"$b"
          done

          # Scoped tusd policy — s3:* limited to tusd-uploads + abc-reserved.
          cat > /tmp/abc-tusd-rw.json <<JSON
          {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::tusd-uploads","arn:aws:s3:::tusd-uploads/*","arn:aws:s3:::abc-reserved","arn:aws:s3:::abc-reserved/*"]}]}
          JSON
          mc admin policy create abc abc-tusd-rw /tmp/abc-tusd-rw.json 2>/dev/null || \\
            mc admin policy update abc abc-tusd-rw /tmp/abc-tusd-rw.json

          # Scoped service user (NOT the MinIO root user). Idempotent.
          mc admin user add abc ${tusdSvcAccessKey} ${tusdSvcSecretKey} 2>/dev/null || true
          mc admin policy attach abc abc-tusd-rw --user ${tusdSvcAccessKey} 2>/dev/null || true
        '
    `,
    triggers: [serverIdentity],
}, { dependsOn: [minioReady] });

// Write the scoped tusd creds into the Nomad Variable nomad/jobs/abc-tusd —
// abc-tusd.nomad.hcl renders these via its `template { env = true }` block,
// exactly like prod. Lives in the abc-reserved namespace (the variable path
// matches the job and the job runs in abc-reserved).
const tusdNomadVar = new command.local.Command("tusd-nomad-var", {
    create: pulumi.interpolate`${nomadExecPrefix}
      nomad var put -namespace=abc-reserved -force nomad/jobs/abc-tusd \\
        AWS_ACCESS_KEY_ID=${tusdSvcAccessKey} \\
        AWS_SECRET_ACCESS_KEY=${tusdSvcSecretKey}
    '`,
    delete: pulumi.interpolate`${nomadExecPrefix}
      nomad var purge -namespace=abc-reserved nomad/jobs/abc-tusd || true
    '`,
    triggers: [serverIdentity],
}, { dependsOn: [reservedNamespace, minioTusdProvision] });

// Deploy the tusd Nomad job. The S3 endpoint placeholder is sed-substituted
// with client-0's IP (where MinIO runs) — the same templating pattern used
// for forward-auth's NOMAD_ADDR_OVERRIDE.
const deployTusd = new command.local.Command("deploy-tusd", {
    create: pulumi.interpolate`
        multipass transfer ${path.join(__dirname, "nomad-jobs", "abc-tusd.nomad.hcl")} \\
          abc-server:/tmp/abc-tusd.nomad.hcl
        ${nomadExecPrefix}
          sed -i "s|\\$\{MINIO_ENDPOINT_OVERRIDE\}|${client0.ipv4}|g" /tmp/abc-tusd.nomad.hcl
          nomad job run /tmp/abc-tusd.nomad.hcl
        '
    `,
    triggers: [serverIdentity, fs.readFileSync(path.join(__dirname, "nomad-jobs", "abc-tusd.nomad.hcl"), "utf8")],
}, { dependsOn: [tusdNomadVar, deployTraefik] });

// ── Per-group provisioning ──────────────────────────────────────────────────
// For each group:
//   1. Create Nomad namespace.
//   2. Apply group-admin-<g> and member-<g> ACL policies from templates.
//   3. Create MinIO bucket.
//   4. For each member: create Nomad ACL token + MinIO service account.

interface MemberCreds {
    nomadToken: pulumi.Output<string>;
    minioAccessKey: pulumi.Output<string>;
    minioSecretKey: pulumi.Output<string>;
}
const allTokens: Record<string, pulumi.Output<string>> = {};
const allMinioCreds: Record<string, pulumi.Output<{ accessKey: string; secretKey: string }>> = {};

for (const g of groups) {
    const ns = g.namespace ?? g.name;
    const bucket = g.bucket ?? g.name;

    // 1. Nomad namespace.
    const nsResource = new command.local.Command(`group-${g.name}-namespace`, {
        create: pulumi.interpolate`${nomadExecPrefix}
          nomad namespace apply -description "abc-node group ${g.name}" ${ns}
        '`,
        delete: pulumi.interpolate`${nomadExecPrefix}
          nomad namespace delete ${ns} || true
        '`,
    }, { dependsOn: [bootstrapReady] });

    // 2. Policies (group-admin + member). The template uses __GROUP__ as a
    // placeholder; sed-substitute before applying.
    const policyResource = new command.local.Command(`group-${g.name}-policies`, {
        create: pulumi.interpolate`${nomadExecPrefix}
          sed "s/__GROUP__/${ns}/g" /etc/nomad-policies/group-admin.hcl.tmpl > /tmp/p-admin-${ns}.hcl
          sed "s/__GROUP__/${ns}/g" /etc/nomad-policies/member.hcl.tmpl      > /tmp/p-member-${ns}.hcl
          nomad acl policy apply -description "group admin ${ns}"  group-admin-${ns} /tmp/p-admin-${ns}.hcl
          nomad acl policy apply -description "group member ${ns}" member-${ns}      /tmp/p-member-${ns}.hcl
        '`,
        delete: pulumi.interpolate`${nomadExecPrefix}
          nomad acl policy delete group-admin-${ns} || true
          nomad acl policy delete member-${ns} || true
        '`,
    }, { dependsOn: [nsResource] });

    // 3. MinIO bucket.
    const bucketResource = new command.local.Command(`group-${g.name}-bucket`, {
        create: pulumi.interpolate`
          multipass exec abc-server -- bash -c '
            mc mb --ignore-existing abc/${bucket}
          '
        `,
        // Don't delete buckets on `pulumi destroy` — researcher data lives
        // there. Operator deletes manually if/when retiring a group.
    }, { dependsOn: [minioReady] });

    // 4. Per-member token + MinIO service account.
    for (const m of g.members) {
        const policyName = m.role === "admin" ? `group-admin-${ns}` : `member-${ns}`;
        const tokenName  = `${ns}-${m.username}`;

        // Nomad ACL token. The Secret ID is what researchers use as
        // X-Nomad-Token / NOMAD_TOKEN.
        const tok = new command.local.Command(`token-${ns}-${m.username}`, {
            create: pulumi.interpolate`${nomadExecPrefix}
              # Reuse an existing token with this name if present (idempotent).
              EXISTING=$(nomad acl token list -json | jq -r ".[] | select(.Name==\\"${tokenName}\\") | .AccessorID" | head -1)
              if [ -n "$EXISTING" ]; then
                nomad acl token info -json "$EXISTING" | jq -r .SecretID
              else
                nomad acl token create -name "${tokenName}" -policy "${policyName}" -type=client -json | jq -r .SecretID
              fi
            '`,
            delete: pulumi.interpolate`${nomadExecPrefix}
              ACC=$(nomad acl token list -json | jq -r ".[] | select(.Name==\\"${tokenName}\\") | .AccessorID" | head -1)
              [ -n "$ACC" ] && nomad acl token delete "$ACC" || true
            '`,
        }, { dependsOn: [policyResource] });

        // MinIO service account, scoped to the member's prefix within the
        // group bucket. The access policy restricts S3 ops to
        // `<bucket>/<username>/*` and `<bucket>/shared/*` (group-shared
        // prefix is read/write for everyone in the group).
        const minioCred = new command.local.Command(`minio-${ns}-${m.username}`, {
            create: pulumi.interpolate`
              multipass exec abc-server -- bash -c '
                cat > /tmp/iam-${ns}-${m.username}.json <<JSON
                {
                  "Version": "2012-10-17",
                  "Statement": [
                    { "Effect": "Allow",
                      "Action": ["s3:*"],
                      "Resource": ["arn:aws:s3:::${bucket}/${m.username}/*",
                                    "arn:aws:s3:::${bucket}/shared/*"] },
                    { "Effect": "Allow",
                      "Action": ["s3:ListBucket"],
                      "Resource": ["arn:aws:s3:::${bucket}"],
                      "Condition": { "StringLike": { "s3:prefix": ["${m.username}/*", "shared/*", "${m.username}", "shared"] } } }
                  ]
                }
                JSON
                # Idempotent: regenerate creds each run is destructive; instead
                # query for an existing service account with our naming convention.
                # mc admin user svcacct prints "Access Key: …" / "Secret Key: …".
                mc admin user svcacct add abc ${minioRootUser} \\
                  --name "${ns}-${m.username}" \\
                  --policy /tmp/iam-${ns}-${m.username}.json 2>/dev/null \\
                  | awk "/Access Key/ {ak=\\$NF} /Secret Key/ {sk=\\$NF} END {print ak\\\" \\\"sk}"
              '
            `,
        }, { dependsOn: [bucketResource] });

        const key = `${g.name}/${m.username}`;
        allTokens[key] = pulumi.secret(tok.stdout.apply(s => s.trim()));
        allMinioCreds[key] = pulumi.secret(minioCred.stdout.apply(s => {
            const [accessKey, secretKey] = s.trim().split(/\s+/);
            return { accessKey: accessKey || "", secretKey: secretKey || "" };
        }));
    }
}

// ── Exports ───────────────────────────────────────────────────────────────────
export const traefikUrl       = pulumi.interpolate`http://${client0.ipv4}`;
export const minioApiUrl      = pulumi.interpolate`http://${client0.ipv4}:9000`;
export const minioConsoleUrl  = pulumi.interpolate`http://${client0.ipv4}:9001`;
export const groupTokens      = pulumi.secret(allTokens);
export const groupMinioCreds  = pulumi.secret(allMinioCreds);
export const groupSummary     = pulumi.output(
    groups.map(g => `${g.name} (ns=${g.namespace ?? g.name}, bucket=${g.bucket ?? g.name}, members=${g.members.map(m => `${m.username}:${m.role}`).join(",")})`)
);

export const serverName      = serverNode.name;
export const serverIpv4      = serverNode.ipv4;
export const nomadAddr       = pulumi.interpolate`http://${serverNode.ipv4}:4646`;
export const serverSnapshotName = serverPostInitSnapshot.snapshotName;

// Client export: list of IPs for all client nodes
export const clientIpv4s = pulumi.all(clientNodes.map(n => n.ipv4));
export const clientNames = pulumi.output(clientNodes.map(n => n.name));

// Instruction exports — printed by `pulumi stack output` for operator convenience
export const bootstrapTokenCmd = pulumi.interpolate`multipass exec abc-server -- sudo cat /etc/nomad-bootstrap-token`;
export const contextAddCmd = pulumi.interpolate`abc auth context add single-server-with-workers --cluster-type abc-nodes --nomad-addr http://${serverNode.ipv4}:4646 --nomad-token <token-from-bootstrap-token-cmd>`;

export const note = pulumi.output(
    "After pulumi up: (1) wait ~90s for cloud-init to finish, " +
    "(2) retrieve token via bootstrapTokenCmd output, " +
    "(3) run contextAddCmd with the token substituted"
);
