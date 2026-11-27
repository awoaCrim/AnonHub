#!/usr/bin/env python3
"""Deploy the current commit's build to the preview server.

  python3 scripts/deploy_preview.py              dry run: build, compare with production, check health; changes nothing
  python3 scripts/deploy_preview.py --apply      deploy what differs; any failure rolls back automatically
  python3 scripts/deploy_preview.py --rollback ID
  python3 scripts/deploy_preview.py --apply --once "scripts/x.mts --data {data}"   also run a one-time data script

A one-time script (--once, repeatable) runs in every patched container while its host is stopped and before the new
code goes in: once to report, then with `--apply --backup <dir>`. `{data}` names the container's data root
(data/yesimbot). The backup holds a copy of each file the script changed, at its path under `{data}`, and in
`created.json` the files it created; a failure or a rollback deletes those and copies the rest back.

Before the owner's host restarts, the deploy waits for the owner's running background tasks to finish (up to
--task-wait minutes, default 30; 0 does not wait): a restart cuts a running task off and its result is lost.

Only build output is shipped: files under the dist/ and lib/ of workspaces production has (and of the host, apps/server,
with what it needs), the image's start scripts, and only files that differ. Old files are kept. A changed workspace package.json ships too, but a change to its runtime dependencies
needs a new base image and is refused. A workspace production lacks ships whole (package.json, dist/, lib/ and its
node_modules link) when a production workspace needs it at run time and production already has every package it
depends on, at the version this checkout resolves; otherwise it is refused too. The owner and every running member are patched in place: only their
host (supervisor program `koishi`) restarts, never NapCat, and each gets a release marker (/opt/yesimbot/.yesimbot-release.json). An image is still
built and pinned for the account manager so later recreations carry the same code; patched members are recorded with
`patchedFrom` so the manager accepts their containers. The remote half is scripts/ops/deploy_preview_remote.py.

"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shlex
import subprocess
import tempfile
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# The host ships with every deploy, with what it needs: no production workspace depends on it.
HOST_WORKSPACES = ("apps/server",)
# The image's start scripts; images from before leave-koishi 6.7 start the host through docker/start-koishi.cjs.
DOCKER_FILES = ("docker/entrypoint.sh", "docker/healthcheck.mjs", "docker/init.mjs", "docker/start-host.sh", "docker/start-koishi.cjs")
REMOTE = REPO / "scripts/ops/deploy_preview_remote.py"
DEPLOYS = "/opt/yesimbot-preview/deploys"
YARN = ["node", str(REPO / ".yarn/releases/yarn-4.12.0.cjs")]


def sh(*args: str, input: bytes | None = None, cwd: Path = REPO, capture: bool = True) -> str:
    result = subprocess.run(args, input=input, cwd=cwd, capture_output=capture)
    if result.returncode:
        detail = (result.stderr or b"").decode(errors="replace").strip()[-800:] if capture else ""
        raise SystemExit(f"{' '.join(args[:3])} failed{': ' + detail if detail else ''}")
    return (result.stdout or b"").decode()


def remote(host: str, command: str, input: bytes | None = None) -> str:
    return sh("ssh", "-o", "ConnectTimeout=15", host, command, input=input)


def remote_helper(host: str, *args: str) -> dict:
    """Run a read-only helper command by piping the helper itself; nothing is written on the server."""
    return json.loads(remote(host, "python3 - " + " ".join(args), input=REMOTE.read_bytes()))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_dependencies(path: Path) -> dict:
    manifest = json.loads(path.read_text())
    return {key: manifest.get(key, {}) for key in ("dependencies", "optionalDependencies", "peerDependencies")}


def local_workspaces() -> dict[str, str]:
    """Package name to workspace directory, for every local workspace with a package.json."""
    found: dict[str, str] = {}
    groups = ("apps", "packages", "platforms", "plugins", "providers")
    for manifest in [REPO / "core/package.json", *(path for group in groups for path in sorted(REPO.glob(f"{group}/*/package.json")))]:
        name = json.loads(manifest.read_text()).get("name")
        if name:
            found[name] = str(manifest.parent.relative_to(REPO))
    return found


def missing_workspaces(production_workspaces: list[str], local: dict[str, str], roots: tuple[str, ...] = ()) -> list[str]:
    """Local workspaces production lacks that a production workspace or one of `roots` needs at run time, directly or
    through another; a root production lacks is one of them."""
    needed = [root for root in roots if root not in production_workspaces and (REPO / root / "package.json").is_file()]
    queue = [workspace for workspace in [*production_workspaces, *needed] if (REPO / workspace / "package.json").is_file()]
    while queue:
        runtime = runtime_dependencies(REPO / queue.pop() / "package.json")
        for entries in runtime.values():
            for name, version in entries.items():
                workspace = local.get(name)
                if str(version).startswith("workspace:") and workspace and workspace not in production_workspaces and workspace not in needed:
                    needed.append(workspace)
                    queue.append(workspace)
    return sorted(needed)


def resolved_version(workspace: str, name: str) -> str | None:
    """The version Node would load for `name` from this workspace: its own node_modules first, then the root."""
    for base in (REPO / workspace / "node_modules", REPO / "node_modules"):
        manifest = base / name / "package.json"
        if manifest.is_file():
            return json.loads(manifest.read_text()).get("version")
    return None


def local_manifest(workspaces: list[str], new: tuple[str, ...] | list[str] = ()) -> dict:
    files: dict[str, str] = {path: sha256(REPO / path) for path in DOCKER_FILES}
    packages: dict[str, dict] = {}
    for workspace in [*workspaces, *new]:
        root = REPO / workspace
        if (root / "package.json").is_file():
            manifest = root / "package.json"
            entry = {"sha": sha256(manifest), "runtime": runtime_dependencies(manifest), "name": json.loads(manifest.read_text()).get("name")}
            entry["resolved"] = {
                name: resolved_version(workspace, name) for entries in entry["runtime"].values() for name, version in entries.items() if not str(version).startswith("workspace:")
            }
            if workspace in new:
                entry["new"] = True
            packages[workspace + "/package.json"] = entry
        for output in ("dist", "lib"):
            for file in sorted((root / output).rglob("*")) if (root / output).is_dir() else []:
                if file.is_file() and not file.is_symlink():
                    files[str(file.relative_to(REPO))] = sha256(file)
    return {"files": files, "packages": packages}


def needs_install(mine: dict, current: dict, workspaces: frozenset = frozenset(), resolved: dict | None = None, installed: dict | None = None) -> bool:
    """A dependency added or re-versioned needs installing; one only removed does not (what is installed stays).
    Neither does a `workspace:` dependency on a workspace production has: Yarn already links it in the root node_modules.
    Nor one production's root node_modules already holds at the version this checkout resolves (`resolved`, `installed`)."""
    return any(
        current.get(kind, {}).get(name) != version
        and not (str(version).startswith("workspace:") and name in workspaces)
        and not ((resolved or {}).get(name) is not None and (resolved or {}).get(name) == (installed or {}).get(name))
        for kind, entries in mine.items()
        for name, version in entries.items()
    )


def link_for(workspace: str, name: str) -> tuple[str, str]:
    """The root node_modules link Yarn makes for a workspace: `node_modules/@s/x` -> `../../packages/x`."""
    return f"node_modules/{name}", "../" * (name.count("/") + 1) + workspace


def make_plan(local: dict, production: dict) -> dict:
    """Files to ship (changed or new), files that are new, links to make, and why it cannot ship if it cannot."""
    files = sorted(path for path, digest in local["files"].items() if production["files"].get(path) != digest)
    added = [path for path in files if path not in production["files"]]
    refused = []
    links: dict[str, str] = {}
    installed = production.get("installed", {})
    new = {path: entry for path, entry in local["packages"].items() if entry.get("new") and path not in production["packages"]}
    for path, entry in sorted(new.items()):
        # Production has no install step: every package it depends on must already be there, at the version this checkout resolves.
        if any(version is None or installed.get(name) != version for name, version in entry["resolved"].items()):
            refused.append(path)
            continue
        files.append(path)
        added.append(path)
        link, target = link_for(path.removesuffix("/package.json"), entry["name"])
        links[link] = target
    shipped_new = {entry["name"] for path, entry in new.items() if path not in refused}
    workspaces = (frozenset(local["packages"][path].get("name") for path in production["packages"] if path in local["packages"]) | shipped_new) - {None}
    for name, current in production["packages"].items():
        mine = local["packages"].get(name)
        if name == "package.json" or mine is None or mine["sha"] == current["sha"]:
            continue
        if needs_install(mine["runtime"], current["runtime"], workspaces, mine.get("resolved"), installed):
            refused.append(name)
        else:
            files.append(name)  # e.g. exports or scripts; installed dependencies still match.
    return {"files": sorted(files), "added": sorted(added), "refused": sorted(refused), "links": links}


def overlay(plan: dict) -> bytes:
    """Files as root, mode 600 like the deployed ones (the image's start scripts keep the image's 755 or 644), then the
    links; paths relative to the app root /opt/yesimbot."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in plan["files"]:
            data = (REPO / path).read_bytes()
            info = tarfile.TarInfo(path)
            mode = (0o755 if (REPO / path).stat().st_mode & 0o100 else 0o644) if path in DOCKER_FILES else 0o600
            info.size, info.mode, info.mtime, info.uid, info.gid, info.uname, info.gname = len(data), mode, int(time.time()), 0, 0, "root", "root"
            archive.addfile(info, io.BytesIO(data))
        for path, target in sorted(plan.get("links", {}).items()):
            info = tarfile.TarInfo(path)
            info.type, info.linkname, info.mode, info.mtime, info.uid, info.gid, info.uname, info.gname = tarfile.SYMTYPE, target, 0o777, int(time.time()), 0, 0, "root", "root"
            archive.addfile(info)
    return buffer.getvalue()


ONCE_PLACEHOLDERS = {"data"}


def once_step(spec: str) -> dict:
    """`scripts/x.mts --data {data}` as a plan step; the bundle keeps the script's name, which its main guard checks."""
    script, *args = shlex.split(spec)
    path = REPO / script
    if not path.is_file() or path.suffix not in (".mts", ".ts", ".mjs"):
        raise SystemExit(f"--once: no script {script}")
    unknown = {name for arg in args for name in re.findall(r"\{(\w+)\}", arg)} - ONCE_PLACEHOLDERS
    if unknown or any(arg in ("--apply", "--backup") for arg in args):
        raise SystemExit(f"--once: {script}: use only {{data}}; --apply and --backup are added by the deploy")
    return {"script": script, "bundle": path.stem + ".mjs", "args": args}


def doubled_workspaces(inputs: list[str]) -> list[str]:
    """Workspaces a bundle took from both their source and their build: two copies of module state, such as the
    foundation's storage root, that do not see each other."""
    taken: dict[str, set[str]] = {}
    for path in inputs:
        parts = path.split("/")
        root, rest = ("core", parts[1:]) if parts[0] == "core" else ("/".join(parts[:2]), parts[2:])
        if parts[0] in ("core", "apps", "packages", "platforms", "plugins", "providers") and rest and rest[0] in ("src", "dist", "lib"):
            taken.setdefault(root, set()).add("src" if rest[0] == "src" else "build")
    return sorted(root for root, kinds in taken.items() if len(kinds) > 1)


def bundle(step: dict, directory: Path) -> bytes:
    """One self-contained ESM file plain node can run inside the container. Workspace packages come from their
    build, as in production: the base tsconfig has none of the root's `paths` to their source."""
    output, meta = directory / step["bundle"], directory / (step["bundle"] + ".meta.json")
    sh(
        str(REPO / "node_modules/.bin/esbuild"), step["script"], "--bundle", "--platform=node", "--format=esm", "--target=node22",
        "--tsconfig=tsconfig.base.json", f"--outfile={output}", f"--metafile={meta}", "--log-level=warning",
        "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    )
    doubled = doubled_workspaces(list(json.loads(meta.read_text())["inputs"]))
    if doubled:
        raise SystemExit(f"--once: {step['script']} bundles both the source and the build of {', '.join(doubled)}")
    return output.read_bytes()


def summarize(plan: dict) -> str:
    groups: dict[str, int] = {}
    for path in plan["files"]:
        parts = path.split("/")
        key = "/".join(parts[:3] if parts[0] != "core" else parts[:2])
        groups[key] = groups.get(key, 0) + 1
    return "\n".join(f"  {count:5d}  {group}" for group, count in sorted(groups.items()))


def follow(host: str, work: str) -> int:
    """Print the remote log until its RESULT line; the deploy keeps running if this connection drops."""
    shown = 0
    while True:
        time.sleep(3)
        try:
            lines = remote(host, f"cat {work}/deploy.log 2>/dev/null || true").splitlines()
        except SystemExit:
            continue
        for line in lines[shown:]:
            print("  " + line, flush=True)
        shown = len(lines)
        result = next((line for line in lines if " RESULT " in line), None)
        if result:
            return 0 if json.loads(result.split(" RESULT ", 1)[1]).get("status") == "deployed" else 1
        try:
            # `[/]` keeps pgrep from matching this ssh command's own shell.
            alive = remote(host, f"pgrep -f '[/]{work.lstrip('/')}/remote.py' >/dev/null && echo yes || echo no").strip()
        except SystemExit:
            continue
        if alive == "no" and " RESULT " not in remote(host, f"cat {work}/deploy.log 2>/dev/null || true"):
            print(f"remote process ended without a result; see {work}/deploy.log", flush=True)
            return 1


def start(host: str, work: str, *args: str) -> None:
    remote(host, f"setsid nohup python3 {work}/remote.py {' '.join(args)} > {work}/deploy.log 2>&1 < /dev/null &")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="ssh1", help="SSH alias of the preview host")
    parser.add_argument("--apply", action="store_true", help="deploy (default is a dry run)")
    parser.add_argument("--skip-build", action="store_true", help="use the current build output as is")
    parser.add_argument("--rollback", metavar="ID", help="undo the deploy with this ID")
    parser.add_argument("--task-wait", type=int, default=30, metavar="MINUTES", help="wait this long for the owner's background tasks (0: do not wait)")
    parser.add_argument("--once", action="append", default=[], metavar="'SCRIPT ARGS'", help="a one-time data script to run in each container (see above)")
    args = parser.parse_args()
    once = [once_step(spec) for spec in args.once]

    if args.rollback:
        work = f"{DEPLOYS}/{args.rollback}"
        start(args.host, work, "rollback", work)
        return follow(args.host, work)

    if sh("git", "status", "--porcelain", "--untracked-files=no").strip():
        raise SystemExit("commit or stash tracked changes first: the build must be exactly a commit")
    commit = sh("git", "rev-parse", "--short=12", "HEAD").strip()
    if not args.skip_build:
        print("building…", flush=True)
        sh(*YARN, "build", capture=False)

    production = remote_helper(args.host, "manifest")
    workspaces = sorted({name.removesuffix("/package.json") for name in production["packages"] if name != "package.json"})
    new = missing_workspaces(workspaces, local_workspaces(), HOST_WORKSPACES)
    plan = make_plan(local_manifest(workspaces, new), production)
    print(f"commit {commit}: {len(plan['files'])} files differ from production ({len(plan['added'])} new)")
    if plan["files"]:
        print(summarize(plan))
    for link, target in sorted(plan["links"].items()):
        print(f"  new workspace link {link} -> {target}")
    staging = tempfile.TemporaryDirectory()
    bundles = {}
    for step in once:
        # Built in the dry run too, so a script that does not bundle stops here.
        bundles[step["bundle"]] = bundle(step, Path(staging.name))
        print(f"  one-time script {step['script']} {' '.join(step['args'])} ({len(bundles[step['bundle']]) // 1024} KiB)")
    if plan["refused"]:
        raise SystemExit("runtime dependencies changed, an overlay cannot install them: " + ", ".join(plan["refused"]))

    check = remote_helper(args.host, "preflight")
    for name, health in check["health"].items():
        state = health.get("error") or ("online" if health.get("online") else "offline")
        notes = [", ".join(health.get(key, [])) for key in ("adapterErrors", "attention") if health.get(key)]
        print(f"  {name}: {state}, {health.get('qqOnline', 0)} QQ online{' (' + '; '.join(notes) + ')' if notes else ''}")
    if check.get("tasks"):
        running = ", ".join(f"{task['id']} ({task['kind']}, {task['status']})" for task in check["tasks"])
        print(f"  owner background tasks running: {running}; a deploy waits up to {args.task_wait} min for them")
    if not check["manager"]:
        raise SystemExit("account manager is not active")
    if check.get("managerPatches") is False:
        raise SystemExit("the installed account manager predates in-place member deploys; install scripts/runtime-manager.mjs first")
    if not plan["files"]:
        print("nothing to deploy")
        return 0
    if not args.apply:
        print("dry run only; add --apply to deploy")
        return 0

    deploy_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + commit
    work = f"{DEPLOYS}/{deploy_id}"
    members = [name for name in check["health"] if name != "yesimbot-preview"]
    remote(args.host, f"install -d -m 700 {DEPLOYS} {work}")
    remote(args.host, f"cat > {work}/remote.py", input=REMOTE.read_bytes())
    remote(args.host, f"cat > {work}/overlay.tar", input=overlay(plan))
    for name, data in bundles.items():
        remote(args.host, f"cat > {work}/{name}", input=data)
    steps = [{"bundle": step["bundle"], "args": step["args"]} for step in once]
    remote(args.host, f"cat > {work}/plan.json", input=json.dumps({**plan, "commit": commit, "members": members, "taskWait": max(args.task_wait, 0) * 60, "once": steps}).encode())
    print(f"deploying {deploy_id}", flush=True)
    start(args.host, work, "deploy", work)
    return follow(args.host, work)


if __name__ == "__main__":
    sys.exit(main())
