#!/usr/bin/env python3
"""Remote half of scripts/deploy_preview.py. Runs as root on the preview host; uploaded fresh for every run.

  manifest           print the owner's deployed output files and package metadata (read-only)
  preflight          print the health of the owner and every member, and the owner's running background tasks (read-only)
  deploy <dir>       apply <dir>/overlay.tar in place: owner and every running member, NapCat never restarted
  rollback <dir>     undo a deploy from its saved state

Owner and each member, the same way: back up the files the overlay overwrites (and the previous release marker),
stop only the `koishi` supervisor program, extract, write /opt/yesimbot/.yesimbot-release.json, start it, check
health (the program is the host, apps/server; it kept Koishi's name). A member's NapCat pid must not change.
Members, once patched, with the account manager stopped (so its monitor cannot react to the host restarts): an image
is still built from the pinned one plus the overlay and becomes the manager's new pin (later recreations get the same
code); each patched member's record in runtimes.json gets `patchedFrom` = the image its container was created from, which
the manager accepts alongside the pin. Then the manager starts and every member must be the same container, healthy, with
the same NapCat pid and registry port.
An account on separate containers (leave-koishi 6.7, `layout: "pod"`) is patched the same way in its app container, which
runs the `koishi` program too; its NapCat pid is that of its `-napcat` container and its port is published by `-net`.
With pod images in the manager config, `pod.app` is rebuilt and repinned beside `image`. NapCat and agent-wechat keep
their own images.
Before the owner's host stops, the deploy waits until the owner runs no background task (plan `taskWait` seconds, 0 to
skip): a restart cuts a running task off. If tasks still run when the wait ends, it gives up before anything changed.
Any failure rolls back automatically: per container restore the backup, delete added files, restart the host; manager
config and runtimes.json come back byte for byte. Old files are never deleted by a deploy, so open WebUI tabs keep their
lazy chunks.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/opt/yesimbot-preview")
DEPLOYS = ROOT / "deploys"
COMPOSE = ROOT / "compose.yaml"
ACCESS = ROOT / "access.txt"
MANAGER_CONFIG = Path("/opt/yesimbot-account-manager/config.json")
MEMBERS_ROOT = Path("/var/lib/yesimbot-members")
MANAGER = "yesimbot-account-manager"
MANAGER_SCRIPT = Path("/opt/yesimbot-account-manager/runtime-manager.mjs")
OWNER = "yesimbot-preview"
APP = "/opt/yesimbot"
SUPERVISOR = "/opt/yesimbot/docker/supervisord.conf"
MEMBER = re.compile(r"^yesimbot-member-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PREV = "-prev"  # only leftovers of older, recreate-style deploys
RUNTIMES = MEMBERS_ROOT / "runtimes.json"
MARKER = "/opt/yesimbot/.yesimbot-release.json"
STATE_DIR = "/var/lib/yesimbot"
# What a one-time script's arguments may name, as paths inside a runtime container.
ONCE_PATHS = {"data": f"{STATE_DIR}/data/yesimbot"}
MARKER_REL = ".yesimbot-release.json"
HEALTH_TIMEOUT = 240
# The owner's background tasks. Only ids, kinds and states are read, never instructions or results.
TASKS = ROOT / "data/koishi/data/yesimbot/tasks/tasks.json"
TASK_WAIT = 30 * 60
TASK_POLL = 30

# Runs inside a container: hashes of workspace output files plus package metadata.
MANIFEST_JS = r"""
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = '/opt/yesimbot', files = {}, packages = {};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// What installed node_modules must satisfy; a change here needs a new base image, not an overlay.
const runtime = (file) => { const m = JSON.parse(fs.readFileSync(file, 'utf8')); return { dependencies: m.dependencies ?? {}, optionalDependencies: m.optionalDependencies ?? {}, peerDependencies: m.peerDependencies ?? {} }; };
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files[path.relative(root, full)] = sha(full);
  }
}
const workspaces = ['core', ...['apps', 'packages', 'platforms', 'plugins', 'providers'].flatMap((group) =>
  fs.existsSync(path.join(root, group)) ? fs.readdirSync(path.join(root, group)).map((name) => group + '/' + name) : [])];
for (const workspace of workspaces) {
  const manifest = path.join(root, workspace, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  packages[workspace + '/package.json'] = { sha: sha(manifest), runtime: runtime(manifest) };
  for (const output of ['dist', 'lib']) if (fs.existsSync(path.join(root, workspace, output))) walk(path.join(root, workspace, output));
}
// The image's start scripts (deploy_preview.py DOCKER_FILES).
for (const entry of fs.readdirSync(path.join(root, 'docker'), { withFileTypes: true })) if (entry.isFile()) files['docker/' + entry.name] = sha(path.join(root, 'docker', entry.name));
if (fs.existsSync(path.join(root, 'package.json'))) packages['package.json'] = { sha: sha(path.join(root, 'package.json')), runtime: runtime(path.join(root, 'package.json')) };
// The version of every package in the root node_modules: what a workspace new to production would load.
const installed = {};
const modules = path.join(root, 'node_modules');
for (const entry of fs.existsSync(modules) ? fs.readdirSync(modules) : []) {
  for (const name of entry.startsWith('@') ? fs.readdirSync(path.join(modules, entry)).map((inner) => entry + '/' + inner) : [entry]) {
    try { installed[name] = JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8')).version; } catch {}
  }
}
process.stdout.write(JSON.stringify({ files, packages, installed }));
"""

# Runs inside a container with {password} on stdin: the administrator can log in and the runtime reports itself.
HEALTH_JS = r"""
const { password } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const origin = process.env.YESIMBOT_PUBLIC_ORIGIN || 'https://yesimbot-koishi.uwoacrimson.com';
let cookie;
const req = (path, body) => fetch('http://127.0.0.1:5140' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
(async () => {
  const login = await req('/yesimbot/admin/login', { username: 'admin', password });
  if (login.status !== 200) throw new Error('login ' + login.status);
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  try {
    const stream = await req('/yesimbot/api/v1/events?topics=panel');
    if (stream.status !== 200) throw new Error('events ' + stream.status);
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    let buffer = '', panel;
    try {
      while (!panel) {
        const { value, done } = await reader.read();
        if (done) throw new Error('events closed');
        buffer += decoder.decode(value, { stream: true });
        for (let at; !panel && (at = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(at + 2)) {
          const raw = /^data: (.*)$/m.exec(buffer.slice(0, at))?.[1];
          if (raw) { const data = JSON.parse(raw); if (data.topic === 'panel') panel = data.data; }
        }
      }
    } finally { await reader.cancel(); }
    // QQ login state is never a deploy gate; other adapters and plugins are.
    process.stdout.write(JSON.stringify({
      online: panel.health.online,
      adapterErrors: panel.adapters.filter((a) => a.platform !== 'onebot' && a.error).map((a) => a.platform + ':' + a.key).sort(),
      // An error-free but disconnected adapter is still down.
      adapterOffline: panel.adapters.filter((a) => a.platform !== 'onebot' && a.enabled !== false && a.state !== 'online').map((a) => a.platform + ':' + a.key).sort(),
      attention: panel.plugins.filter((p) => p.status === 'attention').map((p) => p.key).sort(),
      // Shown by the dry run; QQ login state is never a deploy gate.
      qqOnline: panel.adapters.filter((a) => a.platform === 'onebot' && a.state === 'online').length,
    }));
  } finally { await req('/yesimbot/admin/logout', {}); }
})().catch((error) => { process.stderr.write(String(error.message || error)); process.exitCode = 1; });
"""


class DeployError(RuntimeError):
    pass


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def run(*args: str, input: bytes | None = None, timeout: int = 180, check: bool = True) -> str:
    result = subprocess.run(args, input=input, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise DeployError(f"{' '.join(args[:4])} failed: {result.stderr.decode(errors='replace').strip()[-400:]}")
    return result.stdout.decode()


def containers() -> list[str]:
    names = run("docker", "ps", "--format", "{{.Names}}").split()
    return [name for name in names if MEMBER.match(name)]


def all_containers() -> list[str]:
    return run("docker", "ps", "-a", "--format", "{{.Names}}").split()


def inspect(name: str) -> dict:
    return json.loads(run("docker", "inspect", name))[0]


def supervisor(verb: str, program: str, name: str = OWNER) -> str:
    return run("docker", "exec", name, "/usr/bin/supervisorctl", "-c", SUPERVISOR, verb, program, timeout=120, check=False)


def pod_members() -> set[str]:
    """Accounts on separate containers (leave-koishi 6.7): the app container is patched like any member's, but NapCat
    runs in `<name>-napcat` and `<name>-net` publishes the port."""
    try:
        rows = json.loads(RUNTIMES.read_text()).get("runtimes", [])
    except OSError:
        return set()
    return {"yesimbot-member-" + row["id"] for row in rows if row.get("layout") == "pod"}


def napcat_pid(name: str = OWNER) -> str:
    if name in pod_members():
        # The process Docker started in NapCat's own container; empty while it is not running (or has no QQ account).
        return run("docker", "inspect", "--format", "{{if .State.Running}}{{.State.Pid}}{{end}}", name + "-napcat", check=False).strip()
    return supervisor("pid", "napcat", name).strip()


def manager(verb: str) -> None:
    run("systemctl", verb, MANAGER, timeout=180)


def manager_patches() -> bool:
    """An older manager rejects a patched member's container as unsafe and stops it, which would restart its QQ."""
    try:
        return "patchedFrom" in MANAGER_SCRIPT.read_text()
    except OSError:
        return False


def manager_active() -> bool:
    return run("systemctl", "is-active", MANAGER, check=False).strip() == "active"


def password(name: str) -> str:
    if name == OWNER:
        return ACCESS.read_text().split("Password: ", 1)[1].splitlines()[0]
    return (MEMBERS_ROOT / name.removeprefix("yesimbot-member-") / "backend-password").read_text().strip()


def health(name: str) -> dict:
    out = run("docker", "exec", "-i", name, "node", "-e", HEALTH_JS, input=json.dumps({"password": password(name)}).encode(), timeout=60)
    return json.loads(out)


def problems(after: dict, before: dict | None) -> list[str]:
    """Only new trouble counts: anything already wrong before the deploy is not the deploy's fault."""
    found = []
    if not after.get("online"):
        found.append("not online")
    for key in ("adapterErrors", "adapterOffline", "attention"):
        new = sorted(set(after.get(key, [])) - set((before or {}).get(key, [])))
        if new:
            found.append(f"{key}: {', '.join(new)}")
    return found


def wait_healthy(name: str, before: dict | None, docker_health: bool) -> dict:
    deadline = time.monotonic() + HEALTH_TIMEOUT
    last = "no answer"
    while time.monotonic() < deadline:
        try:
            if docker_health:
                state = inspect(name)["State"]
                status = state.get("Health", {}).get("Status")
                if not state.get("Running") or status == "unhealthy":
                    raise DeployError(f"container {status or 'stopped'}")
                if status != "healthy":
                    raise DeployError(f"container {status}")
            current = health(name)
            issues = problems(current, before)
            if not issues:
                return current
            last = "; ".join(issues)
        except (DeployError, ValueError, subprocess.TimeoutExpired) as error:
            last = str(error)
        time.sleep(3)
    raise DeployError(f"{name} not healthy after {HEALTH_TIMEOUT}s: {last}")


def registry_port_matches(name: str) -> bool:
    """The owner relays to a member through its registry port; it must keep matching Docker's published port."""
    member_id = name.removeprefix("yesimbot-member-")
    port = registry_port(member_id)
    published = name + "-net" if name in pod_members() else name
    mapped = run("docker", "port", published, "5140/tcp", check=False).split()
    return port is not None and mapped == [f"127.0.0.1:{port}"]


def registry_port(member_id: str) -> int | None:
    rows = json.loads(RUNTIMES.read_text())["runtimes"]
    return next((row.get("port") for row in rows if row.get("id") == member_id), None)


def owner_image() -> str:
    found = re.findall(rb'"image"\s*:\s*"(sha256:[0-9a-f]{64})"', COMPOSE.read_bytes())
    if len(found) != 1:
        raise DeployError("compose.yaml must pin exactly one owner image")
    return found[0].decode()


def member_image() -> str:
    image = json.loads(MANAGER_CONFIG.read_bytes()).get("image", "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise DeployError("manager config has no pinned member image")
    return image


def pod_app_image() -> str | None:
    """The app image of accounts on separate containers, when the manager has pod images at all."""
    pod = json.loads(MANAGER_CONFIG.read_bytes()).get("pod")
    if pod is None:
        return None
    image = pod.get("app", "") if isinstance(pod, dict) else ""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise DeployError("manager config has no pinned pod app image")
    return image


def repin(data: bytes, old: str, new: str, key: str = "image") -> bytes:
    """Replace the one quoted image value and nothing else, keeping every other byte."""
    pattern = re.compile(rb'("' + re.escape(key.encode()) + rb'"\s*:\s*)"' + re.escape(old.encode()) + rb'"')
    updated, count = pattern.subn(lambda match: match.group(1) + b'"' + new.encode() + b'"', data)
    if count != 1:
        raise DeployError(f"expected exactly one image pin {old[:19]}")
    return updated


def write_atomic(path: Path, data: bytes) -> None:
    stat = path.stat()
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, stat.st_mode & 0o7777)
    os.chown(temporary, stat.st_uid, stat.st_gid)
    os.replace(temporary, path)


def build_image(base: str, overlay: Path, work: Path, tag: str) -> str:
    context = work / "image"
    (context / "overlay").mkdir(parents=True, exist_ok=True)
    with tarfile.open(overlay) as archive:
        # Our own root-owned overlay; the data filter, where Python has it, also refuses links and absolute paths.
        archive.extractall(context / "overlay", **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
    # BuildKit reads `FROM sha256:…` as an image name on Docker Hub; build from a local tag of the same image.
    tags = json.loads(run("docker", "image", "inspect", "--format", "{{json .RepoTags}}", base)) or []
    if not tags:
        tags = [tag + "-base"]
        run("docker", "tag", base, tags[0])
    (context / "Dockerfile").write_text(f"FROM {tags[0]}\nCOPY overlay/ {APP}/\n")
    run("docker", "build", "--network", "none", "--pull=false", "-q", "-t", tag, str(context), timeout=600)
    return run("docker", "image", "inspect", "--format", "{{.Id}}", tag).strip()


def save(work: Path, state: dict) -> None:
    (work / "state.json").write_text(json.dumps(state, indent=1))


def container_files(name: str, paths: list[str]) -> bytes:
    """A tar of the given existing files of a container (the backup)."""
    return subprocess.run(
        ["docker", "exec", "-i", name, "tar", "-C", APP, "-cf", "-", "--null", "-T", "-"],
        input="\0".join(paths).encode(), capture_output=True, check=True, timeout=180,
    ).stdout


def container_extract(name: str, archive: Path) -> None:
    with archive.open("rb") as stream:
        result = subprocess.run(["docker", "exec", "-i", name, "tar", "-C", APP, "--no-same-owner", "-xf", "-"], stdin=stream, capture_output=True, timeout=180)
    if result.returncode:
        raise DeployError("extract failed: " + result.stderr.decode(errors="replace")[-400:])


EXISTING_JS = r"""
const fs = require('fs'), path = require('path');
const paths = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(paths.filter((p) => { try { return fs.statSync(path.join('/opt/yesimbot', p)).isFile(); } catch { return false; } })));
"""

REMOVE_JS = r"""
const fs = require('fs'), path = require('path');
const app = '/opt/yesimbot';
const { paths, links = [], manifests = [] } = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const p of paths) {
  const f = path.normalize(path.join(app, p));
  // Only build output, the image's start scripts and the release marker are ever ours to delete.
  if (!f.startsWith(app + '/') || !(f.includes('/dist/') || f.includes('/lib/') || path.dirname(f) === app + '/docker' || f === app + '/.yesimbot-release.json')) continue;
  try { if (fs.statSync(f).isFile()) fs.unlinkSync(f); } catch {}
}
// A workspace this deploy brought: its node_modules link and its package.json.
for (const p of links) {
  const f = path.normalize(path.join(app, p));
  if (!f.startsWith(app + '/node_modules/')) continue;
  try { if (fs.lstatSync(f).isSymbolicLink()) fs.unlinkSync(f); } catch {}
}
for (const p of manifests) {
  const f = path.normalize(path.join(app, p));
  if (!f.startsWith(app + '/') || path.basename(f) !== 'package.json') continue;
  try { if (fs.lstatSync(f).isFile()) fs.unlinkSync(f); } catch {}
}
"""


# Undoes a one-time script from its backup: delete what it lists as created, copy the rest back over the data root.
UNDO_JS = r"""
const fs = require('fs'), path = require('path');
const { backup, data } = JSON.parse(fs.readFileSync(0, 'utf8'));
if (fs.existsSync(backup)) {
  const created = path.join(backup, 'created.json');
  if (fs.existsSync(created)) {
    for (const p of JSON.parse(fs.readFileSync(created, 'utf8'))) {
      const f = path.normalize(path.join(data, p));
      if (f.startsWith(data + '/')) fs.rmSync(f, { force: true });
    }
  }
  fs.cpSync(backup, data, { recursive: true, force: true, filter: (source) => source !== created });
}
"""


def container_existing(name: str, paths: list[str]) -> list[str]:
    return json.loads(run("docker", "exec", "-i", name, "node", "-e", EXISTING_JS, input=json.dumps(paths).encode()))


def container_remove(name: str, paths: list[str], links: list[str] | None = None, manifests: list[str] | None = None) -> None:
    payload = {"paths": paths, "links": links or [], "manifests": manifests or []}
    run("docker", "exec", "-i", name, "node", "-e", REMOVE_JS, input=json.dumps(payload).encode())


def write_marker(name: str, marker: dict) -> None:
    run("docker", "exec", "-i", name, "sh", "-c", f"cat > {MARKER}", input=json.dumps(marker).encode())


def restart_koishi(name: str, apply) -> None:
    """Stop only the host in a container, run apply(), and always start it again."""
    supervisor("stop", "koishi", name)
    if "RUNNING" in supervisor("status", "koishi", name):
        raise DeployError(f"{name}: the host did not stop")
    try:
        apply()
    finally:
        supervisor("start", "koishi", name)


def backup_name(name: str) -> str:
    return "backup.tar" if name == OWNER else f"backup-{name.removeprefix('yesimbot-member-')}.tar"


def short_name(name: str) -> str:
    return "owner" if name == OWNER else name.removeprefix("yesimbot-member-")[:8]


def run_once(work: Path, state: dict, name: str, entry: dict, step: dict) -> None:
    """A one-time script in a container whose host is stopped: a report, then the real run with a backup on the data volume.
    The backup is recorded before the real run starts, so an interrupted run is undone too."""
    where = f"/tmp/yesimbot-once-{work.name}"
    run("docker", "exec", name, "mkdir", "-p", where)
    run("docker", "cp", str(work / step["bundle"]), f"{name}:{where}/{step['bundle']}")
    command = ["docker", "exec", name, "node", f"{where}/{step['bundle']}", *[arg.format(**ONCE_PATHS) for arg in step["args"]]]
    stem = Path(step["bundle"]).stem
    (work / f"once-{short_name(name)}-{stem}-report.json").write_text(run(*command, timeout=1800))
    backup = f"{STATE_DIR}/data/deploy-backups/{work.name}/{stem}"
    entry.setdefault("once", []).append({"bundle": step["bundle"], "backup": backup})
    save(work, state)
    (work / f"once-{short_name(name)}-{stem}-applied.json").write_text(run(*command, "--apply", "--backup", backup, timeout=1800))
    log(f"{short_name(name)}: {stem} applied")


def undo_once(work: Path, state: dict, name: str, entry: dict) -> None:
    """Undo the container's one-time scripts, newest first, each at most once."""
    for done in reversed(entry.get("once", [])):
        if done.get("undone"):
            continue
        run("docker", "exec", "-i", name, "node", "-e", UNDO_JS, input=json.dumps({"backup": done["backup"], "data": ONCE_PATHS["data"]}).encode())
        done["undone"] = True
        save(work, state)
        log(f"{short_name(name)}: {Path(done['bundle']).stem} undone")


def patch_container(work: Path, state: dict, name: str, plan: dict, overlay: Path, marker: dict) -> None:
    """Overlay one container in place. The state entry is saved before anything changes, so rollback can always undo it.
    One-time scripts run first, while the old code is still in place: if one fails, its data comes back and the host starts
    on the old code."""
    existing = container_existing(name, plan["files"] + [MARKER_REL])
    entry = {
        "backup": backup_name(name),
        "added": [path for path in plan["files"] if path not in existing],
        "marker": MARKER_REL in existing,
        # A workspace new to production: rollback removes its link and package.json too.
        "links": sorted(plan.get("links", {})),
        "manifests": [path for path in plan["files"] if path.endswith("/package.json") and path not in existing],
    }
    (work / entry["backup"]).write_bytes(container_files(name, existing))
    state["patched"][name] = entry
    save(work, state)

    def apply() -> None:
        try:
            for step in plan.get("once", []):
                run_once(work, state, name, entry, step)
        except Exception:
            undo_once(work, state, name, entry)
            raise
        container_extract(name, overlay)
        write_marker(name, marker)

    restart_koishi(name, apply)


def unpatch_container(work: Path, name: str, entry: dict, state: dict) -> None:
    def restore() -> None:
        undo_once(work, state, name, entry)
        container_extract(name, work / entry["backup"])
        container_remove(name, entry["added"] + ([] if entry["marker"] else [MARKER_REL]), entry.get("links"), entry.get("manifests"))

    restart_koishi(name, restore)


def active_tasks() -> list[dict]:
    """The owner's running or queued background tasks. A host restart cuts them off and they end as unknown (preview
    tasks 2885c0d6 and 2be3bb47, cut off by two deploys on 2026-11-20)."""
    for _ in range(3):
        try:
            rows = json.loads(TASKS.read_text())
            break
        except FileNotFoundError:
            return []
        except json.JSONDecodeError:
            time.sleep(1)
    else:
        raise DeployError("the owner's task store is unreadable")
    return [
        {"id": str(row.get("id", ""))[:8], "kind": row.get("kind"), "status": row.get("status")}
        for row in rows
        if isinstance(row, dict) and row.get("status") in ("running", "queued")
    ]


def wait_tasks(limit: int) -> None:
    """Return once the owner runs no background task; give up after `limit` seconds. 0 skips the wait."""
    if limit <= 0:
        return
    deadline = time.monotonic() + limit
    shown = None
    while active := active_tasks():
        running = ", ".join(f"{task['id']} ({task['kind']}, {task['status']})" for task in active)
        if time.monotonic() >= deadline:
            raise DeployError(f"owner background tasks still running after {limit // 60} min: {running}")
        if running != shown:
            log(f"waiting for owner background tasks: {running}")
            shown = running
        time.sleep(TASK_POLL)


def cmd_manifest() -> None:
    print(run("docker", "exec", OWNER, "node", "-e", MANIFEST_JS, timeout=120))


def cmd_preflight() -> None:
    names = [OWNER, *containers()]
    report = {
        "manager": manager_active(), "managerPatches": manager_patches(), "napcatPid": napcat_pid(), "ownerImage": owner_image(), "memberImage": member_image(),
        "tasks": active_tasks(), "health": {},
    }
    for name in names:
        try:
            report["health"][name] = health(name)
        except DeployError as error:
            report["health"][name] = {"error": str(error)}
    print(json.dumps(report))


def cmd_deploy(work: Path) -> None:
    plan = json.loads((work / "plan.json").read_text())
    overlay = work / "overlay.tar"
    if not manager_active():
        raise DeployError("account manager is not active")
    members = containers()
    if members and not manager_patches():
        raise DeployError("the installed account manager predates in-place member deploys; install scripts/runtime-manager.mjs first")
    expected = set(plan.get("members", members))
    if set(members) != expected:
        raise DeployError(f"members changed since the plan: {sorted(set(members) ^ expected)}")
    napcat = napcat_pid()
    marker = {"commit": plan.get("commit"), "deployId": work.name, "deployedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    state: dict = {
        "phase": "started", "napcatPid": napcat, "members": members, "ownerImage": owner_image(), "memberImage": member_image(), "patched": {},
        "podAppImage": pod_app_image(),
    }
    log(f"before: owner + {len(members)} members, NapCat pid {napcat}")
    state["before"] = {name: health(name) for name in [OWNER, *members]}
    # Leftovers of the old recreate-style deploys; a stopped `-prev` container is only kept for one manual rollback.
    for name in all_containers():
        if name.endswith(PREV) and MEMBER.match(name.removesuffix(PREV)) and not inspect(name)["State"]["Running"]:
            run("docker", "rm", name)
    save(work, state)

    log("building images")
    tag = "yesimbot:deploy-" + work.name
    state["newOwnerImage"] = build_image(state["ownerImage"], overlay, work, tag + "-owner")
    state["newMemberImage"] = build_image(state["memberImage"], overlay, work, tag + "-member")
    if state["podAppImage"]:
        state["newPodAppImage"] = build_image(state["podAppImage"], overlay, work, tag + "-pod-app")
    save(work, state)
    # Nothing has changed yet; giving up here needs no rollback.
    wait_tasks(int(plan.get("taskWait", TASK_WAIT)))

    try:
        log(f"owner: replacing {len(plan['files'])} files ({len(plan['added'])} new), restarting the host only")
        state["phase"] = "owner"
        patch_container(work, state, OWNER, plan, overlay, marker)
        wait_healthy(OWNER, state["before"][OWNER], docker_health=False)
        if napcat_pid() != napcat:
            raise DeployError("NapCat restarted")
        log("owner healthy")

        if members:
            log(f"members: patching {len(members)} in place, restarting the host only")
            (work / "manager-config.bak").write_bytes(MANAGER_CONFIG.read_bytes())
            (work / "runtimes.json.bak").write_bytes(RUNTIMES.read_bytes())
            state["phase"] = "members"
            save(work, state)
            # Stopped first: its monitor must not read the host restarts below as a crash and escalate.
            manager("stop")
            identity = {}
            for name in members:
                info = inspect(name)
                identity[name] = {"id": info["Id"], "image": info["Image"], "napcatPid": napcat_pid(name), "port": registry_port(name.removeprefix("yesimbot-member-"))}
                state["identity"] = identity
                patch_container(work, state, name, plan, overlay, marker)
                wait_healthy(name, state["before"][name], docker_health=False)
                if napcat_pid(name) != identity[name]["napcatPid"]:
                    raise DeployError(f"{name}: NapCat restarted")
                log(f"{name[16:24]} patched")
            pins = repin(MANAGER_CONFIG.read_bytes(), state["memberImage"], state["newMemberImage"])
            # A later move to separate containers (stage 7) or a recreated app part must carry this code too.
            if state["podAppImage"]:
                pins = repin(pins, state["podAppImage"], state["newPodAppImage"], "app")
            write_atomic(MANAGER_CONFIG, pins)
            rows = json.loads(RUNTIMES.read_text())
            for row in rows["runtimes"]:
                name = "yesimbot-member-" + row["id"]
                if name in identity:
                    row["patchedFrom"] = identity[name]["image"]
            written = (json.dumps(rows, separators=(",", ":")) + "\n").encode()
            write_atomic(RUNTIMES, written)
            state["runtimesWritten"] = hashlib.sha256(written).hexdigest()
            save(work, state)
            # Docker's own health must be good again before the manager's monitor starts watching.
            for name in members:
                wait_healthy(name, state["before"][name], docker_health=True)
            manager("start")
            for name in members:
                info = inspect(name)
                if info["Id"] != identity[name]["id"]:
                    raise DeployError(f"{name} was recreated")
                wait_healthy(name, state["before"][name], docker_health=True)
                if napcat_pid(name) != identity[name]["napcatPid"]:
                    raise DeployError(f"{name}: NapCat restarted")
                deadline = time.monotonic() + 60
                while not (registry_port(name.removeprefix("yesimbot-member-")) == identity[name]["port"] and registry_port_matches(name)):
                    if time.monotonic() > deadline:
                        raise DeployError(f"{name}: registry port does not match its Docker port")
                    time.sleep(2)
                log(f"{name[16:24]} healthy, same container, NapCat pid unchanged")

        write_atomic(COMPOSE, repin(COMPOSE.read_bytes(), state["ownerImage"], state["newOwnerImage"]))
        state["phase"] = "done"
        save(work, state)
        log("RESULT " + json.dumps({"status": "deployed", "commit": plan.get("commit"), "files": len(plan["files"]), "members": len(members)}))
    except BaseException as error:
        log(f"FAILED: {error}; rolling back")
        rollback(work, state)
        log("RESULT " + json.dumps({"status": "rolled-back", "error": str(error)}))
        raise SystemExit(1)


def restore_runtimes(work: Path, state: dict, names: list[str]) -> None:
    """Byte for byte while the file is still the one the deploy wrote. If the manager has changed it since (a later
    registration, say), only the patchedFrom of the patched members goes back, so nothing else is lost."""
    backup = work / "runtimes.json.bak"
    if not backup.exists():
        return
    original, current = backup.read_bytes(), RUNTIMES.read_bytes()
    if current == original:
        return
    if hashlib.sha256(current).hexdigest() == state.get("runtimesWritten"):
        write_atomic(RUNTIMES, original)
        return
    previous = {row["id"]: row.get("patchedFrom") for row in json.loads(original)["runtimes"]}
    rows = json.loads(current)
    for row in rows["runtimes"]:
        if "yesimbot-member-" + row["id"] in names:
            if previous.get(row["id"]) is None:
                row.pop("patchedFrom", None)
            else:
                row["patchedFrom"] = previous[row["id"]]
    write_atomic(RUNTIMES, (json.dumps(rows, separators=(",", ":")) + "\n").encode())


def rollback(work: Path, state: dict) -> None:
    patched = state.get("patched", {})
    if state.get("phase") == "members":
        manager("stop")
        for name, entry in patched.items():
            if name != OWNER:
                unpatch_container(work, name, entry, state)
        if (work / "manager-config.bak").exists() and MANAGER_CONFIG.read_bytes() != (work / "manager-config.bak").read_bytes():
            write_atomic(MANAGER_CONFIG, (work / "manager-config.bak").read_bytes())
        restore_runtimes(work, state, [name for name in patched if name != OWNER])
        manager("start")
        for name in patched:
            if name != OWNER:
                wait_healthy(name, state.get("before", {}).get(name), docker_health=True)
                if name in state.get("identity", {}) and napcat_pid(name) != state["identity"][name]["napcatPid"]:
                    log(f"WARNING {name}: NapCat pid changed during the deploy")
        log("members restored")
    if OWNER in patched:
        unpatch_container(work, OWNER, patched[OWNER], state)
        wait_healthy(OWNER, state.get("before", {}).get(OWNER), docker_health=False)
        log("owner restored")
    if COMPOSE.read_bytes().count(state.get("newOwnerImage", "-").encode()):
        write_atomic(COMPOSE, repin(COMPOSE.read_bytes(), state["newOwnerImage"], state["ownerImage"]))
    state["phase"] = "rolled-back"
    save(work, state)


def main() -> None:
    command, *rest = sys.argv[1:] or ["help"]
    if command == "manifest":
        return cmd_manifest()
    if command == "preflight":
        return cmd_preflight()
    if command not in ("deploy", "rollback") or len(rest) != 1:
        raise SystemExit(__doc__)
    work = Path(rest[0]).resolve()
    if work.parent != DEPLOYS:
        raise SystemExit("deploy directory must be under " + str(DEPLOYS))
    try:
        with open(DEPLOYS / ".lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if command == "deploy":
                cmd_deploy(work)
            else:
                state = json.loads((work / "state.json").read_text())
                if state.get("phase") == "done":
                    state["phase"] = "members" if any(name != OWNER for name in state.get("patched", {})) else "owner"
                rollback(work, state)
                log("RESULT " + json.dumps({"status": "rolled-back"}))
    except SystemExit:
        raise
    except BaseException as error:
        # Before anything changed (or a rollback that could not finish): the caller still gets a result line.
        log("RESULT " + json.dumps({"status": "failed", "error": f"{type(error).__name__}: {error}"[-600:]}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
