// One account as four containers on one network namespace (leave-koishi 6.7, owner decision 2026-11-25). `net` alone
// is on the member's bridge and publishes the backend port; the app, NapCat (the unmodified upstream image) and
// agent-wechat join its namespace and reach each other on 127.0.0.1, as they did inside one container. So the
// firewall, NapCat's loopback-only WebUI and the loopback-only OneBot ingress stay as they were, and each part
// restarts alone: a new app never restarts QQ or WeChat, and a QQ crash never restarts the app.
//
// Docker arguments come only from root configuration, the UUID and the record, as in runtime-manager.mjs.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const POD_PARTS = Object.freeze(["net", "app", "napcat", "wechat"]);
/** The label naming a container's part, next to the runtime label. */
export const PART_LABEL = "io.yesimbot.part";
/** Where the NapCat container finds the wrapper that keeps an explicit QQ logout across restarts. */
export const NAPCAT_WRAPPER_TARGET = "/opt/yesimbot/start-napcat.sh";
/** The same set the single container has: the upstream QQ entrypoint changes users and owners. */
const QQ_CAPS = Object.freeze(["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"]);
/** The app reads and writes NapCat's settings, which NapCat's own user may own. */
const APP_CAPS = QQ_CAPS;
const NET_LIMITS = Object.freeze({ cpus: 0.25, memoryMB: 32, pids: 16, shmMB: 16 });
/** Upstream NapCat prints login QR codes and tokens: its output never reaches a container log, as in the single container. */
const NO_LOG = Object.freeze({ Type: "none", Config: {} });
const JSON_LOG = Object.freeze({ Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } });
const WECHAT_LIMITS = Object.freeze({ cpus: 1, memoryMB: 512, pids: 256, shmMB: 64 });

/** The installed wrapper next to the manager, else the checkout's. */
export function napcatWrapper() {
  const installed = new URL("./start-napcat.sh", import.meta.url);
  return fileURLToPath(fs.existsSync(installed) ? installed : new URL("../docker/start-napcat.sh", import.meta.url));
}

export function podNames(id) {
  const base = "yesimbot-member-" + id;
  return { net: base + "-net", app: base, napcat: base + "-napcat", wechat: base + "-wechat" };
}

/** The parts an account runs: NapCat only with a QQ account. */
export function podParts(r) {
  return POD_PARTS.filter((part) => part !== "napcat" || r.qqAccount);
}

/** Each part's bind mounts: [source, target, readonly]. */
export function podMounts(directory, wrapper) {
  return {
    net: [],
    app: [
      [directory + "/koishi", "/var/lib/yesimbot", false],
      [directory + "/napcat-config", "/app/napcat/config", false],
      [directory + "/backend-password", "/run/secrets/admin-password", true],
      [directory + "/policy", "/run/yesimbot/policy", true],
    ],
    napcat: [
      [directory + "/qq", "/app/.config/QQ", false],
      [directory + "/napcat-config", "/app/napcat/config", false],
      [directory + "/napcat-plugins", "/app/napcat/plugins", false],
      [wrapper, NAPCAT_WRAPPER_TARGET, true],
    ],
    wechat: [[directory + "/koishi/data/agent-wechat", "/var/lib/yesimbot/data/agent-wechat", false]],
  };
}

/**
 * What each part must be. `env` is what the app or NapCat was created for; a change recreates that part.
 * `images` are the image IDs a part may run: the pin, and for a running part the one it was created from.
 */
export function podSpec(part, { r, config, directory, network, netId, wrapper, env }) {
  const caps = { net: [], app: APP_CAPS, napcat: QQ_CAPS, wechat: [] }[part];
  const limits = { net: NET_LIMITS, app: config.caps, napcat: config.caps, wechat: WECHAT_LIMITS }[part];
  return {
    part,
    name: podNames(r.id)[part],
    caps,
    limits,
    mounts: podMounts(directory, wrapper)[part],
    log: part === "napcat" ? NO_LOG : JSON_LOG,
    networkMode: part === "net" ? network : "container:" + netId,
    env: part === "app" ? env.app : part === "napcat" ? env.napcat : [],
  };
}

/** `docker create` arguments for one part. */
export function podCreateArgs(spec, { id, image }) {
  const { limits } = spec;
  const args = [
    "create",
    "--name",
    spec.name,
    "--label",
    "io.yesimbot.runtime=" + id,
    "--label",
    PART_LABEL + "=" + spec.part,
    "--restart",
    "no",
    "--cpus",
    String(limits.cpus),
    "--memory",
    limits.memoryMB + "m",
    "--memory-swap",
    limits.memoryMB + "m",
    "--pids-limit",
    String(limits.pids),
    "--shm-size",
    limits.shmMB + "m",
    "--log-driver",
    spec.log.Type,
    ...Object.entries(spec.log.Config).flatMap(([key, value]) => ["--log-opt", key + "=" + value]),
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    ...spec.caps.flatMap((cap) => ["--cap-add", cap]),
    "--network",
    spec.networkMode,
  ];
  // Only the namespace's owner publishes or tunes the network; Docker refuses both on the others.
  if (spec.part === "net") args.push("--publish", "127.0.0.1::5140", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1");
  for (const value of spec.env) args.push("--env", value);
  for (const [source, target, readonly] of spec.mounts) args.push("--mount", "type=bind,src=" + source + ",dst=" + target + (readonly ? ",readonly" : ""));
  if (spec.part === "net") args.push("--entrypoint", "/usr/bin/tini", image, "--", "sleep", "infinity");
  else if (spec.part === "napcat") args.push("--workdir", "/app", "--entrypoint", "/bin/bash", image, NAPCAT_WRAPPER_TARGET);
  else args.push(image);
  return args;
}

/** Whether `c` is exactly the part `spec` describes, on one of `images`. */
export function validPodContainer(c, spec, id, images) {
  const h = c?.HostConfig;
  if (!c || !h || !images.includes(c.Image)) return false;
  if (c.Config?.Labels?.["io.yesimbot.runtime"] !== id || c.Config?.Labels?.[PART_LABEL] !== spec.part) return false;
  if (h.Privileged || h.PidMode || h.NetworkMode !== spec.networkMode || h.RestartPolicy?.Name !== "no") return false;
  const caps = Array.isArray(h.CapAdd) ? h.CapAdd.map((value) => (typeof value === "string" ? value.toUpperCase().replace(/^CAP_/, "") : "")) : [];
  if (!h.CapDrop?.includes("ALL") || caps.length !== spec.caps.length || caps.some((cap) => !spec.caps.includes(cap))) return false;
  const { limits } = spec;
  if (
    !h.SecurityOpt?.includes("no-new-privileges:true") ||
    h.NanoCpus !== Math.round(limits.cpus * 1e9) ||
    h.Memory !== limits.memoryMB * 1024 * 1024 ||
    h.MemorySwap !== h.Memory ||
    h.PidsLimit !== limits.pids ||
    h.ShmSize !== limits.shmMB * 1024 * 1024 ||
    h.LogConfig?.Type !== spec.log.Type ||
    Object.entries(spec.log.Config).some(([key, value]) => h.LogConfig?.Config?.[key] !== value) ||
    h.Binds?.length ||
    h.Devices?.length ||
    h.DeviceRequests?.length ||
    h.VolumesFrom?.length ||
    h.ExtraHosts?.length ||
    h.Links?.length
  )
    return false;
  const ports = Object.keys(h.PortBindings || {});
  const networks = Object.keys(c.NetworkSettings?.Networks || {});
  if (spec.part === "net") {
    if (h.Sysctls?.["net.ipv6.conf.all.disable_ipv6"] !== "1") return false;
    if (ports.length !== 1 || h.PortBindings["5140/tcp"]?.length !== 1 || h.PortBindings["5140/tcp"][0].HostIp !== "127.0.0.1") return false;
    if (networks.length !== 1 || networks[0] !== spec.networkMode) return false;
  } else if (ports.length || networks.length) return false;
  const expected = new Map(spec.mounts.map(([source, target, readonly]) => [target, { source, readonly }]));
  return (
    (c.Mounts?.length ?? 0) === expected.size &&
    !(c.Mounts ?? []).some((m) => m.Type !== "bind" || expected.get(m.Destination)?.source !== m.Source || (expected.get(m.Destination).readonly && m.RW))
  );
}

/** The created-for environment of a part, read back from Docker, in `spec.env`'s keys. */
export function podEnvDrift(c, spec) {
  const env = c?.Config?.Env ?? [];
  return spec.env.some((value) => !env.includes(value));
}

/** A program entry for the ops view from a part's container, in the shape `parseSupervisor` gives. */
export function containerProgram(info, now = Date.now()) {
  if (!info) return { state: "STOPPED" };
  if (!info.State?.Running) return { state: info.State?.Status === "exited" ? "EXITED" : "STOPPED" };
  const program = { state: "RUNNING" };
  if (Number.isInteger(info.State.Pid) && info.State.Pid > 0) program.pid = info.State.Pid;
  const started = Date.parse(info.State.StartedAt ?? "");
  if (Number.isFinite(started)) program.uptimeSeconds = Math.max(0, Math.floor((now - started) / 1000));
  return program;
}

/** Whether a joined part started before the namespace it joined did, so it holds a stale one. */
export function staleJoin(c, net) {
  const joined = Date.parse(c?.State?.StartedAt ?? ""),
    owner = Date.parse(net?.State?.StartedAt ?? "");
  return Number.isFinite(joined) && Number.isFinite(owner) && joined < owner;
}
