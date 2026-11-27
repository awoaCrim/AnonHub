"""Pure parts of the preview deploy: what ships, how images are re-pinned, what counts as unhealthy."""
import importlib.util
import io
import sys
import tarfile
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


local = load("deploy_preview", SCRIPTS / "deploy_preview.py")
remote = load("deploy_preview_remote", SCRIPTS / "ops" / "deploy_preview_remote.py")
RUNTIME = {"dependencies": {"a": "1"}, "optionalDependencies": {}, "peerDependencies": {}}
FIXTURE = "scripts/tests/fixtures/once-storage.mts"


class PlanTest(unittest.TestCase):
    def test_ships_changed_and_new_files_and_keeps_production_only_files(self):
        plan = local.make_plan(
            {"files": {"core/dist/a.js": "new", "core/dist/b.js": "same", "core/dist/c.js": "added"}, "packages": {}},
            {"files": {"core/dist/a.js": "old", "core/dist/b.js": "same", "core/dist/stale.js": "x"}, "packages": {}},
        )
        self.assertEqual(plan["files"], ["core/dist/a.js", "core/dist/c.js"])
        self.assertEqual(plan["added"], ["core/dist/c.js"])
        self.assertEqual(plan["refused"], [])

    def test_ships_a_package_json_whose_dependencies_match_and_refuses_one_whose_dependencies_changed(self):
        production = {"files": {}, "packages": {"core/package.json": {"sha": "1", "runtime": RUNTIME}, "plugins/x/package.json": {"sha": "1", "runtime": RUNTIME}}}
        changed = {**RUNTIME, "dependencies": {"a": "2"}}
        plan = local.make_plan(
            {"files": {}, "packages": {"core/package.json": {"sha": "2", "runtime": RUNTIME}, "plugins/x/package.json": {"sha": "2", "runtime": changed}}},
            production,
        )
        self.assertEqual(plan["files"], ["core/package.json"])
        self.assertEqual(plan["refused"], ["plugins/x/package.json"])

    def test_ships_a_package_json_that_only_drops_a_dependency_and_refuses_one_that_adds_or_moves_one(self):
        before = {"dependencies": {"a": "1"}, "optionalDependencies": {}, "peerDependencies": {"p": "1"}}
        production = {"files": {}, "packages": {name: {"sha": "1", "runtime": before} for name in ("plugins/x/package.json", "plugins/y/package.json", "plugins/z/package.json")}}
        dropped = {**before, "peerDependencies": {}}
        added = {**before, "dependencies": {"a": "1", "b": "1"}}
        moved = {**before, "dependencies": {"a": "1", "p": "1"}, "peerDependencies": {}}
        plan = local.make_plan(
            {
                "files": {},
                "packages": {
                    "plugins/x/package.json": {"sha": "2", "runtime": dropped},
                    "plugins/y/package.json": {"sha": "2", "runtime": added},
                    "plugins/z/package.json": {"sha": "2", "runtime": moved},
                },
            },
            production,
        )
        self.assertEqual(plan["files"], ["plugins/x/package.json"])
        self.assertEqual(plan["refused"], ["plugins/y/package.json", "plugins/z/package.json"])

    def test_ships_a_new_workspace_dependency_only_on_a_workspace_production_already_links(self):
        before = {"dependencies": {"a": "1"}, "optionalDependencies": {}, "peerDependencies": {}}
        production = {"files": {}, "packages": {name: {"sha": "1", "runtime": before} for name in ("plugins/x/package.json", "plugins/y/package.json", "packages/t/package.json")}}
        linked = {**before, "dependencies": {"a": "1", "@s/t": "workspace:^"}}
        unknown = {**before, "dependencies": {"a": "1", "@s/new": "workspace:^"}}
        plan = local.make_plan(
            {
                "files": {},
                "packages": {
                    "plugins/x/package.json": {"sha": "2", "runtime": linked, "name": "x"},
                    "plugins/y/package.json": {"sha": "2", "runtime": unknown, "name": "y"},
                    "packages/t/package.json": {"sha": "1", "runtime": before, "name": "@s/t"},
                    "packages/new/package.json": {"sha": "1", "runtime": before, "name": "@s/new"},
                },
            },
            production,
        )
        self.assertEqual(plan["files"], ["plugins/x/package.json"])
        self.assertEqual(plan["refused"], ["plugins/y/package.json"])

    def test_ships_a_missing_runtime_workspace_whole_when_production_has_its_dependencies_at_the_resolved_version(self):
        before = {"dependencies": {"a": "1"}, "optionalDependencies": {}, "peerDependencies": {}}
        needs = {**before, "dependencies": {"a": "1", "@s/f": "workspace:^"}}
        own = {"dependencies": {"u": "^6.28.0", "@s/t": "workspace:^"}, "optionalDependencies": {}, "peerDependencies": {}}
        local_side = {
            "files": {"core/dist/a.js": "2", "packages/f/dist/index.js": "1"},
            "packages": {
                "core/package.json": {"sha": "2", "runtime": needs, "name": "core"},
                "packages/t/package.json": {"sha": "1", "runtime": before, "name": "@s/t"},
                "packages/f/package.json": {"sha": "1", "runtime": own, "name": "@s/f", "new": True, "resolved": {"u": "6.28.0"}},
            },
        }
        production = {
            "files": {"core/dist/a.js": "1"},
            "packages": {"core/package.json": {"sha": "1", "runtime": before}, "packages/t/package.json": {"sha": "1", "runtime": before}},
            "installed": {"u": "6.28.0"},
        }
        plan = local.make_plan(local_side, production)
        self.assertEqual(plan["files"], ["core/dist/a.js", "core/package.json", "packages/f/dist/index.js", "packages/f/package.json"])
        self.assertEqual(plan["added"], ["packages/f/dist/index.js", "packages/f/package.json"])
        self.assertEqual(plan["links"], {"node_modules/@s/f": "../../packages/f"})
        self.assertEqual(plan["refused"], [])
        # Production has another version, or none: nothing installs it, so the workspace and what needs it are refused.
        for installed in ({"u": "6.21.0"}, {}):
            plan = local.make_plan(local_side, {**production, "installed": installed})
            self.assertEqual(plan["refused"], ["core/package.json", "packages/f/package.json"])
            self.assertEqual(plan["links"], {})

    def test_ships_a_workspace_that_adds_a_dependency_production_already_has_at_the_resolved_version(self):
        before = {"dependencies": {"u": "^6.28.0"}, "optionalDependencies": {}, "peerDependencies": {}}
        after = {**before, "dependencies": {"u": "^6.28.0", "z": "^3.25.76"}}
        local_side = {
            "files": {"packages/f/dist/index.js": "2"},
            "packages": {"packages/f/package.json": {"sha": "2", "runtime": after, "name": "@s/f", "resolved": {"u": "6.28.0", "z": "3.25.76"}}},
        }
        production = {
            "files": {"packages/f/dist/index.js": "1"},
            "packages": {"packages/f/package.json": {"sha": "1", "runtime": before}},
            "installed": {"u": "6.28.0", "z": "3.25.76"},
        }
        plan = local.make_plan(local_side, production)
        self.assertEqual(plan["files"], ["packages/f/dist/index.js", "packages/f/package.json"])
        self.assertEqual(plan["refused"], [])
        # Another version in production, or none, still needs a new base image.
        for installed in ({"u": "6.28.0", "z": "3.22.0"}, {"u": "6.28.0"}):
            self.assertEqual(local.make_plan(local_side, {**production, "installed": installed})["refused"], ["packages/f/package.json"])

    def test_finds_the_workspaces_production_lacks_that_it_needs_at_run_time(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifests = {
                "core": {"name": "core", "dependencies": {"@s/f": "workspace:^"}},
                "packages/f": {"name": "@s/f", "dependencies": {"@s/g": "workspace:^", "u": "^1.0.0"}},
                "packages/g": {"name": "@s/g"},
                "packages/e2e": {"name": "@s/e2e", "devDependencies": {"@s/f": "workspace:^"}},
            }
            for workspace, manifest in manifests.items():
                (root / workspace).mkdir(parents=True)
                (root / workspace / "package.json").write_text(json.dumps(manifest))
            with mock.patch.object(local, "REPO", root):
                found = local.local_workspaces()
                self.assertEqual(local.missing_workspaces(["core"], found), ["packages/f", "packages/g"])
                self.assertEqual(local.missing_workspaces(["core", "packages/f", "packages/g"], found), [])

    def test_the_new_host_ships_with_what_it_needs_although_no_production_workspace_depends_on_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifests = {
                "core": {"name": "core"},
                "apps/server": {"name": "@s/server", "dependencies": {"core": "workspace:^", "@s/onebot": "workspace:^"}},
                "platforms/onebot": {"name": "@s/onebot", "dependencies": {"core": "workspace:^"}},
            }
            for workspace, manifest in manifests.items():
                (root / workspace).mkdir(parents=True)
                (root / workspace / "package.json").write_text(json.dumps(manifest))
            with mock.patch.object(local, "REPO", root):
                found = local.local_workspaces()
                self.assertEqual(found["@s/onebot"], "platforms/onebot")
                self.assertEqual(local.missing_workspaces(["core"], found), [])
                self.assertEqual(local.missing_workspaces(["core"], found, ("apps/server",)), ["apps/server", "platforms/onebot"])
                self.assertEqual(local.missing_workspaces(["apps/server", "core", "platforms/onebot"], found, ("apps/server",)), [])

    def test_the_start_scripts_ship_with_the_image_modes(self):
        self.assertIn("docker/start-koishi.cjs", local.local_manifest([])["files"])
        archive = tarfile.open(fileobj=io.BytesIO(local.overlay({"files": ["docker/entrypoint.sh", "docker/init.mjs", "core/package.json"]})))
        modes = {member.name: member.mode for member in archive.getmembers()}
        self.assertEqual(modes, {"docker/entrypoint.sh": 0o755, "docker/init.mjs": 0o644, "core/package.json": 0o600})

    def test_a_one_time_script_names_only_the_data_root(self):
        step = local.once_step(f"{FIXTURE} --data {{data}}")
        self.assertEqual(step, {"script": FIXTURE, "bundle": "once-storage.mjs", "args": ["--data", "{data}"]})
        for spec in (f"{FIXTURE} --data {{home}}", f"{FIXTURE} --koishi {{koishi}}", f"{FIXTURE} --data {{data}} --apply", "scripts/missing.mts"):
            with self.assertRaises(SystemExit):
                local.once_step(spec)

    def test_a_bundle_with_both_the_source_and_the_build_of_a_workspace_is_found(self):
        inputs = ["scripts/x.mts", "plugins/usage/src/table.ts", "packages/foundation/dist/index.js", "packages/foundation/src/storage.ts", "core/src/a.ts"]
        self.assertEqual(local.doubled_workspaces(inputs), ["packages/foundation"])
        self.assertEqual(local.doubled_workspaces(inputs[:3] + ["core/dist/index.js"]), [])

    def test_bundles_from_workspace_builds_so_a_script_and_a_plugin_table_share_one_storage(self):
        if not (local.REPO / "node_modules/.bin/esbuild").exists() or not (local.REPO / "packages/foundation/dist/index.js").exists() or not shutil.which("node"):
            self.skipTest("needs an installed and built checkout and node")
        with tempfile.TemporaryDirectory() as directory:
            data = local.bundle(local.once_step(FIXTURE), Path(directory))
            self.assertEqual(data.count(b'throw new Error("storage not configured")'), 1)
            # Run it: the plugin table finds the root the script configured.
            result = subprocess.run(["node", str(Path(directory) / "once-storage.mjs"), directory], capture_output=True, text=True)
            self.assertEqual((result.returncode, result.stdout), (0, "0\n"), result.stderr[-400:])

    def test_overlay_writes_a_new_workspace_link_as_a_symlink(self):
        archive = tarfile.open(fileobj=io.BytesIO(local.overlay({"files": [], "links": {"node_modules/@s/f": "../../packages/f"}})))
        [member] = archive.getmembers()
        self.assertTrue(member.issym())
        self.assertEqual((member.name, member.linkname, member.uid), ("node_modules/@s/f", "../../packages/f", 0))

    def test_overlay_files_are_root_owned_mode_600_at_their_repository_paths(self):
        archive = tarfile.open(fileobj=io.BytesIO(local.overlay({"files": ["scripts/deploy_preview.py"]})))
        [member] = archive.getmembers()
        self.assertEqual((member.name, member.uid, member.gid, member.mode), ("scripts/deploy_preview.py", 0, 0, 0o600))


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class UndoScriptTest(unittest.TestCase):
    def test_deletes_what_the_backup_lists_as_created_and_copies_the_rest_back(self):
        with tempfile.TemporaryDirectory() as directory:
            data, backup = Path(directory) / "data", Path(directory) / "backup"
            (data / "channels/a").mkdir(parents=True)
            (data / "channels/a/messages.jsonl").write_text("converted\n")
            (data / "state.sqlite").write_text("new")
            (data / "state.sqlite-wal").write_text("wal")
            (data / "untouched.json").write_text("keep")
            (backup / "channels/a").mkdir(parents=True)
            (backup / "channels/a/messages.jsonl").write_text("original\n")
            (backup / "created.json").write_text(json.dumps(["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "../outside"]))
            (Path(directory) / "outside").write_text("not ours")
            subprocess.run(["node", "-e", remote.UNDO_JS], input=json.dumps({"backup": str(backup), "data": str(data)}).encode(), check=True)
            self.assertEqual((data / "channels/a/messages.jsonl").read_text(), "original\n")
            self.assertFalse((data / "state.sqlite").exists())
            self.assertFalse((data / "state.sqlite-wal").exists())
            self.assertFalse((data / "created.json").exists())
            self.assertEqual((data / "untouched.json").read_text(), "keep")
            self.assertTrue((Path(directory) / "outside").exists())
            # A script that changed nothing left no backup directory: nothing to undo.
            subprocess.run(["node", "-e", remote.UNDO_JS], input=json.dumps({"backup": str(backup) + "-none", "data": str(data)}).encode(), check=True)


class RemoteTest(unittest.TestCase):
    old, new = "sha256:" + "a" * 64, "sha256:" + "b" * 64

    def test_repin_replaces_exactly_the_one_image_value(self):
        data = b'{\n  "image": "' + self.old.encode() + b'",\n  "port": 1\n}\n'
        self.assertEqual(remote.repin(data, self.old, self.new), data.replace(self.old.encode(), self.new.encode()))
        with self.assertRaises(remote.DeployError):
            remote.repin(data + data, self.old, self.new)
        with self.assertRaises(remote.DeployError):
            remote.repin(b'{"other": "' + self.old.encode() + b'"}', self.old, self.new)

    def test_only_new_trouble_fails_health(self):
        before = {"online": True, "adapterErrors": ["wechat-bridge:main"], "attention": ["google"]}
        self.assertEqual(remote.problems(before, before), [])
        self.assertEqual(remote.problems({**before, "attention": ["google", "memorizer"]}, before), ["attention: memorizer"])
        self.assertEqual(remote.problems({**before, "online": False}, before), ["not online"])
        self.assertEqual(remote.problems({**before, "adapterOffline": ["xiaoheihe:a"]}, before), ["adapterOffline: xiaoheihe:a"])
        self.assertEqual(remote.problems(before, None), ["adapterErrors: wechat-bridge:main", "attention: google"])



class BuildImageTest(unittest.TestCase):
    def build(self, tags):
        calls = []

        def run(*args, **_):
            calls.append(args)
            if args[:3] == ("docker", "image", "inspect") and "RepoTags" in args[4]:
                return tags
            return "sha256:new\n"

        original, remote.run = remote.run, run
        try:
            import tempfile

            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                buffer = io.BytesIO()
                with tarfile.open(fileobj=buffer, mode="w"):
                    pass
                (work / "overlay.tar").write_bytes(buffer.getvalue())
                image = remote.build_image("sha256:" + "a" * 64, work / "overlay.tar", work, "yesimbot:deploy-x-member")
                return image, (work / "image" / "Dockerfile").read_text(), calls
        finally:
            remote.run = original

    def test_builds_from_a_local_tag_because_buildkit_reads_an_image_id_as_a_hub_name(self):
        image, dockerfile, calls = self.build('["yesimbot:previous-member"]')
        self.assertEqual(image, "sha256:new")
        self.assertTrue(dockerfile.startswith("FROM yesimbot:previous-member\n"))
        self.assertFalse(any(call[:2] == ("docker", "tag") for call in calls))
        _, dockerfile, calls = self.build("[]")
        self.assertTrue(dockerfile.startswith("FROM yesimbot:deploy-x-member-base\n"))
        self.assertIn(("docker", "tag", "sha256:" + "a" * 64, "yesimbot:deploy-x-member-base"), calls)


OLD, NEW, PATCHED = "sha256:" + "a" * 64, "sha256:" + "b" * 64, "sha256:" + "c" * 64
POD_APP, NEW_POD_APP = "sha256:" + "d" * 64, "sha256:" + "e" * 64
M1 = "yesimbot-member-11111111-1111-4111-8111-111111111111"
M2 = "yesimbot-member-22222222-2222-4222-8222-222222222222"


class PodMemberTest(unittest.TestCase):
    """An account on separate containers: NapCat and the published port are read from its other containers."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        runtimes = Path(directory.name) / "runtimes.json"
        runtimes.write_text(json.dumps({"version": 1, "runtimes": [{"id": M1[16:], "port": 22000}, {"id": M2[16:], "port": 22001, "layout": "pod"}]}))
        self.calls = []

        def run(*args, input=None, timeout=180, check=True):
            self.calls.append(args)
            if args[:2] == ("docker", "port"):
                return "127.0.0.1:22001\n" if args[2] == M2 + "-net" else "127.0.0.1:22000\n"
            if args[:2] == ("docker", "inspect"):
                return "4242\n"
            return "21\n"

        for name, value in {"RUNTIMES": runtimes, "run": run}.items():
            patcher = mock.patch.object(remote, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_napcat_pid_is_its_own_container_s_process(self):
        self.assertEqual(remote.napcat_pid(M2), "4242")
        self.assertEqual(self.calls[-1][-1], M2 + "-napcat")
        self.assertEqual(remote.napcat_pid(M1), "21")
        self.assertEqual(self.calls[-1][3], "/usr/bin/supervisorctl")

    def test_the_port_is_the_one_its_namespace_container_publishes(self):
        self.assertTrue(remote.registry_port_matches(M2))
        self.assertEqual(self.calls[-1][2], M2 + "-net")
        self.assertTrue(remote.registry_port_matches(M1))
        self.assertEqual(self.calls[-1][2], M1)


class InPlaceDeployTest(unittest.TestCase):
    """cmd_deploy against a fake host: every container, supervisor and manager call is recorded."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.work = base / "deploys" / "20261119T000000Z-abc"
        self.work.mkdir(parents=True)
        (self.work / "overlay.tar").write_bytes(b"overlay")
        (self.work / "plan.json").write_text(json.dumps({"files": ["core/dist/a.js", "core/dist/new.js"], "added": ["core/dist/new.js"], "commit": "abc", "members": [M1, M2]}))
        self.config = base / "config.json"
        self.config_bytes = b'{\n  "image": "' + OLD.encode() + b'",\n  "port": 1\n}\n'
        self.config.write_bytes(self.config_bytes)
        self.runtimes = base / "runtimes.json"
        self.runtimes_bytes = (
            json.dumps({"version": 1, "runtimes": [{"id": m[16:], "port": 22000 + i, "state": "running"} for i, m in enumerate((M1, M2))]}, separators=(",", ":")) + "\n"
        ).encode()
        self.runtimes.write_bytes(self.runtimes_bytes)
        self.compose = base / "compose.yaml"
        self.compose.write_bytes(b'"image": "' + OLD.encode() + b'"\n')
        self.events = []
        self.fail_on = None
        self.napcat = {remote.OWNER: "16", M1: "21", M2: "22"}
        self.ids = {M1: "id1", M2: "id2"}
        self.manager_state = {"active": True}
        self.manager_patches = True
        self.tasks = base / "tasks.json"
        for name, value in {"DEPLOYS": base / "deploys", "MANAGER_CONFIG": self.config, "RUNTIMES": self.runtimes, "COMPOSE": self.compose, "TASKS": self.tasks}.items():
            patcher = mock.patch.object(remote, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, fake in {
            "manager_active": lambda: True,
            "manager_patches": lambda: self.manager_patches,
            "containers": lambda: [M1, M2],
            "all_containers": lambda: [remote.OWNER, M1, M2],
            "owner_image": lambda: OLD,
            "napcat_pid": lambda name=remote.OWNER: self.napcat[name],
            "health": lambda name: {"online": True},
            "build_image": lambda base, overlay, work, tag: NEW,
            "manager": lambda verb: self.events.append(("manager", verb)),
            "inspect": lambda name: {"Id": self.ids.get(name, "owner"), "Image": PATCHED if name == M2 else OLD, "State": {"Running": True}},
            "wait_healthy": self.wait_healthy,
            "container_existing": lambda name, paths: ["core/dist/a.js"] + ([remote.MARKER_REL] if name == M2 else []),
            "container_files": lambda name, paths: b"backup:" + name.encode(),
            "container_extract": lambda name, archive: self.events.append(("extract", name, archive.name)),
            "container_remove": self.remove,
            "write_marker": lambda name, marker: self.events.append(("marker", name, marker["deployId"], marker["commit"])),
            "supervisor": self.supervisor,
            "registry_port_matches": lambda name: True,
        }.items():
            patcher = mock.patch.object(remote, name, fake)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.directory.cleanup)

    def remove(self, name, paths, links=None, manifests=None):
        self.events.append(("remove", name, tuple(paths)))
        if links or manifests:
            self.events.append(("remove-workspace", name, tuple(links or ()), tuple(manifests or ())))

    def supervisor(self, verb, program, name=remote.OWNER):
        self.events.append(("supervisor", verb, program, name))
        return "koishi STOPPED" if verb == "status" else ""

    def wait_healthy(self, name, before, docker_health):
        if self.fail_on == (name, docker_health):
            raise remote.DeployError("not healthy")
        return {}

    def kinds(self, kind):
        return [event for event in self.events if event[0] == kind]

    def test_members_are_patched_in_place_then_repinned_with_patched_from(self):
        remote.cmd_deploy(self.work)
        self.assertEqual(self.kinds("manager"), [("manager", "stop"), ("manager", "start")])
        # Per container: only Koishi is stopped and started; NapCat is never named.
        self.assertFalse([event for event in self.kinds("supervisor") if event[2] == "napcat" and event[1] != "pid"])
        for name in (remote.OWNER, M1, M2):
            stops = [i for i, event in enumerate(self.events) if event == ("supervisor", "stop", "koishi", name)]
            starts = [i for i, event in enumerate(self.events) if event == ("supervisor", "start", "koishi", name)]
            extract = [i for i, event in enumerate(self.events) if event[:2] == ("extract", name)]
            marker = [i for i, event in enumerate(self.events) if event[:2] == ("marker", name)]
            self.assertTrue(stops[0] < extract[0] < marker[0] < starts[0], name)
            self.assertEqual(self.events[marker[0]][2:], ("20261119T000000Z-abc", "abc"))
        # The manager is stopped before any member is touched and restarted only after the pin and records changed.
        first_member = next(i for i, event in enumerate(self.events) if event[:2] == ("supervisor", "stop") and event[3] == M1)
        self.assertLess(self.events.index(("manager", "stop")), first_member)
        self.assertEqual(self.config.read_bytes(), self.config_bytes.replace(OLD.encode(), NEW.encode()))
        rows = {row["id"]: row for row in json.loads(self.runtimes.read_text())["runtimes"]}
        self.assertEqual(rows[M1[16:]]["patchedFrom"], OLD)
        self.assertEqual(rows[M2[16:]]["patchedFrom"], PATCHED)
        self.assertEqual(rows[M1[16:]]["port"], 22000)
        self.assertEqual(json.loads((self.work / "state.json").read_text())["phase"], "done")
        # Backups: files the overlay overwrites plus the previous marker; added files are recorded for removal.
        state = json.loads((self.work / "state.json").read_text())
        self.assertEqual(state["patched"][M1], {"backup": "backup-11111111-1111-4111-8111-111111111111.tar", "added": ["core/dist/new.js"], "marker": False, "links": [], "manifests": []})
        self.assertTrue(state["patched"][M2]["marker"])
        self.assertTrue(self.compose.read_bytes().count(NEW.encode()))

    def write_tasks(self, *statuses):
        rows = [
            {"id": f"{index:08x}-1111-4111-8111-111111111111", "kind": "computer", "status": status, "instruction": "SECRET_INSTRUCTION", "result": "SECRET_RESULT"}
            for index, status in enumerate(statuses)
        ]
        self.tasks.write_text(json.dumps(rows))

    def test_waits_for_the_owners_running_tasks_before_stopping_its_koishi(self):
        # Two deploys on 2026-11-20 cut off running tasks (preview 2885c0d6, 2be3bb47).
        self.write_tasks("running", "queued", "succeeded")
        waits = []

        def sleep(seconds):
            waits.append(seconds)
            self.events.append(("slept",))
            self.write_tasks("succeeded", "running" if len(waits) < 2 else "failed", "succeeded")

        with mock.patch.object(remote.time, "sleep", sleep), mock.patch.object(remote.sys, "stdout", io.StringIO()) as out:
            remote.cmd_deploy(self.work)
        self.assertEqual(waits, [remote.TASK_POLL, remote.TASK_POLL])
        first_stop = self.events.index(("supervisor", "stop", "koishi", remote.OWNER))
        self.assertLess(max(i for i, event in enumerate(self.events) if event == ("slept",)), first_stop)
        log = out.getvalue()
        self.assertIn("waiting for owner background tasks: 00000000 (computer, running), 00000001 (computer, queued)", log)
        self.assertIn("waiting for owner background tasks: 00000001 (computer, running)", log)
        self.assertNotIn("SECRET", log)
        self.assertEqual(json.loads((self.work / "state.json").read_text())["phase"], "done")

    def test_gives_up_before_touching_anything_when_tasks_keep_running(self):
        self.write_tasks("running")
        plan = json.loads((self.work / "plan.json").read_text())
        (self.work / "plan.json").write_text(json.dumps({**plan, "taskWait": 60}))
        clock = iter(range(0, 10_000, 31))
        with mock.patch.object(remote.time, "sleep", lambda seconds: None), mock.patch.object(remote.time, "monotonic", lambda: next(clock)):
            with self.assertRaisesRegex(remote.DeployError, "still running after 1 min: 00000000 \\(computer, running\\)"):
                remote.cmd_deploy(self.work)
        self.assertFalse(self.kinds("supervisor"))
        self.assertFalse(self.kinds("manager"))
        self.assertEqual(self.config.read_bytes(), self.config_bytes)
        self.assertEqual(self.compose.read_bytes(), b'"image": "' + OLD.encode() + b'"\n')

    def test_a_task_wait_of_zero_does_not_wait(self):
        self.write_tasks("running")
        plan = json.loads((self.work / "plan.json").read_text())
        (self.work / "plan.json").write_text(json.dumps({**plan, "taskWait": 0}))
        with mock.patch.object(remote.time, "sleep", lambda seconds: self.fail("waited")):
            remote.cmd_deploy(self.work)
        self.assertIn(("supervisor", "stop", "koishi", remote.OWNER), self.events)

    def test_lists_only_ids_kinds_and_states_of_running_tasks(self):
        self.write_tasks("running", "waiting", "queued")
        self.assertEqual(
            remote.active_tasks(),
            [{"id": "00000000", "kind": "computer", "status": "running"}, {"id": "00000002", "kind": "computer", "status": "queued"}],
        )
        self.tasks.unlink()
        self.assertEqual(remote.active_tasks(), [])

    def test_refuses_before_touching_anything_while_the_installed_manager_predates_patched_members(self):
        self.manager_patches = False
        with self.assertRaises(remote.DeployError):
            remote.cmd_deploy(self.work)
        self.assertEqual(self.events, [])
        self.assertEqual(self.config.read_bytes(), self.config_bytes)
        self.assertEqual(self.runtimes.read_bytes(), self.runtimes_bytes)

    def as_pod(self, member):
        """`member` on separate containers, and the manager with pod images."""
        rows = json.loads(self.runtimes_bytes)
        next(row for row in rows["runtimes"] if row["id"] == member[16:])["layout"] = "pod"
        self.runtimes_bytes = (json.dumps(rows, separators=(",", ":")) + "\n").encode()
        self.runtimes.write_bytes(self.runtimes_bytes)
        self.config_bytes = b'{\n  "image": "' + OLD.encode() + b'",\n  "pod": {\n    "app": "' + POD_APP.encode() + b'",\n    "napcat": "napcat:1",\n    "wechat": "wechat:1"\n  }\n}\n'
        self.config.write_bytes(self.config_bytes)
        builds = []
        patcher = mock.patch.object(remote, "build_image", lambda base, overlay, work, tag: builds.append((base, tag)) or (NEW_POD_APP if base == POD_APP else NEW))
        patcher.start()
        self.addCleanup(patcher.stop)
        return builds

    def test_an_account_on_separate_containers_is_patched_in_its_app_container_and_pod_app_repinned(self):
        builds = self.as_pod(M2)
        remote.cmd_deploy(self.work)
        # Its app container runs the same supervisor program; only Koishi stops and starts there.
        self.assertIn(("supervisor", "stop", "koishi", M2), self.events)
        self.assertIn(("supervisor", "start", "koishi", M2), self.events)
        self.assertIn((POD_APP, "yesimbot:deploy-20261119T000000Z-abc-pod-app"), builds)
        self.assertEqual(self.config.read_bytes(), self.config_bytes.replace(OLD.encode(), NEW.encode()).replace(POD_APP.encode(), NEW_POD_APP.encode()))
        rows = {row["id"]: row for row in json.loads(self.runtimes.read_text())["runtimes"]}
        self.assertEqual(rows[M2[16:]]["patchedFrom"], PATCHED)
        self.assertEqual(rows[M2[16:]]["layout"], "pod")

    def test_a_failed_account_on_separate_containers_rolls_back_both_pins(self):
        self.as_pod(M2)
        calls = []

        def healthy(name, before, docker_health):
            # Once the pins are written: the second Docker health check of the pod's app container.
            calls.append((name, docker_health))
            if name == M2 and docker_health and calls.count((M2, True)) == 2:
                raise remote.DeployError("not healthy")
            return {}

        with mock.patch.object(remote, "wait_healthy", healthy), self.assertRaises(SystemExit):
            remote.cmd_deploy(self.work)
        self.assertEqual(self.config.read_bytes(), self.config_bytes)
        self.assertEqual(self.runtimes.read_bytes(), self.runtimes_bytes)

    def test_a_pod_without_a_pinned_app_image_is_refused_before_anything_changes(self):
        self.as_pod(M2)
        self.config_bytes = self.config_bytes.replace(POD_APP.encode(), b"yesimbot-app:latest")
        self.config.write_bytes(self.config_bytes)
        with self.assertRaisesRegex(remote.DeployError, "pod app image"):
            remote.cmd_deploy(self.work)
        self.assertEqual(self.events, [])
        self.assertEqual(self.config.read_bytes(), self.config_bytes)

    def test_any_member_failure_rolls_back_every_container_and_both_files_byte_for_byte(self):
        self.fail_on = (M2, False)
        with self.assertRaises(SystemExit):
            remote.cmd_deploy(self.work)
        self.assertEqual(self.config.read_bytes(), self.config_bytes)
        self.assertEqual(self.runtimes.read_bytes(), self.runtimes_bytes)
        self.assertEqual(self.compose.read_bytes(), b'"image": "' + OLD.encode() + b'"\n')
        self.assertEqual(self.kinds("manager"), [("manager", "stop"), ("manager", "stop"), ("manager", "start")])
        for name in (remote.OWNER, M1, M2):
            self.assertIn(("extract", name, remote.backup_name(name)), self.events)
        # Added files go; a marker that did not exist before goes too, one that did comes back from the backup.
        self.assertIn(("remove", M1, ("core/dist/new.js", remote.MARKER_REL)), self.events)
        self.assertIn(("remove", M2, ("core/dist/new.js",)), self.events)
        self.assertEqual(json.loads((self.work / "state.json").read_text())["phase"], "rolled-back")

    def with_once(self, fail=None):
        """A plan with one one-time script; `run` records docker calls and fails the real run in container `fail`."""
        plan = json.loads((self.work / "plan.json").read_text())
        plan["once"] = [{"bundle": "convert-history-parts.mjs", "args": ["--data", "{data}"]}]
        (self.work / "plan.json").write_text(json.dumps(plan))

        def run(*args, input=None, timeout=180, check=True):
            if args[:2] == ("docker", "exec") and "-e" in args and input and b'"backup"' in input:
                self.events.append(("undo", args[3], json.loads(input)["backup"]))
            elif args[:2] == ("docker", "exec") and args[3] == "node":
                self.events.append(("once", args[2], "apply" if "--apply" in args else "report", args[5:]))
                if fail == args[2] and "--apply" in args:
                    raise remote.DeployError("conversion failed")
            return "{}"

        patcher = mock.patch.object(remote, "run", run)
        patcher.start()
        self.addCleanup(patcher.stop)
        return f"{remote.STATE_DIR}/data/deploy-backups/{self.work.name}/convert-history-parts"

    def test_one_time_scripts_report_then_apply_with_a_backup_before_the_new_code_goes_in(self):
        backup = self.with_once()
        remote.cmd_deploy(self.work)
        for name in (remote.OWNER, M1, M2):
            mine = [event for event in self.events if len(event) > 1 and event[1] == name and event[0] in ("once", "extract")]
            self.assertEqual(
                mine,
                [
                    ("once", name, "report", ("--data", remote.ONCE_PATHS["data"])),
                    ("once", name, "apply", ("--data", remote.ONCE_PATHS["data"], "--apply", "--backup", backup)),
                    ("extract", name, "overlay.tar"),
                ],
            )
        self.assertEqual(self.kinds("undo"), [])

    def test_a_failed_one_time_script_is_undone_once_and_the_container_keeps_its_old_code(self):
        backup = self.with_once(fail=remote.OWNER)
        with self.assertRaises(SystemExit):
            remote.cmd_deploy(self.work)
        self.assertNotIn(("extract", remote.OWNER, "overlay.tar"), self.events)
        self.assertEqual(self.kinds("undo"), [("undo", remote.OWNER, backup)])
        # Koishi was started again after the undo, on the old code.
        undone = self.events.index(("undo", remote.OWNER, backup))
        self.assertEqual(self.events[undone + 1], ("supervisor", "start", "koishi", remote.OWNER))

    def test_rollback_after_a_member_failed_undoes_every_container_s_one_time_scripts(self):
        backup = self.with_once()
        self.fail_on = (M2, False)
        with self.assertRaises(SystemExit):
            remote.cmd_deploy(self.work)
        self.assertEqual(sorted(self.kinds("undo")), sorted(("undo", name, backup) for name in (remote.OWNER, M1, M2)))

    def test_rollback_removes_the_link_and_package_json_of_a_workspace_the_deploy_brought(self):
        plan = json.loads((self.work / "plan.json").read_text())
        plan["files"] += ["packages/f/dist/index.js", "packages/f/package.json"]
        plan["added"] += ["packages/f/dist/index.js", "packages/f/package.json"]
        plan["links"] = {"node_modules/@s/f": "../../packages/f"}
        (self.work / "plan.json").write_text(json.dumps(plan))
        self.fail_on = (M2, False)
        with self.assertRaises(SystemExit):
            remote.cmd_deploy(self.work)
        for name in (remote.OWNER, M1, M2):
            self.assertIn(("remove-workspace", name, ("node_modules/@s/f",), ("packages/f/package.json",)), self.events)

    def test_failure_after_the_manager_restarted_still_restores_everything(self):
        calls = []

        def healthy(name, before, docker_health):
            calls.append((name, docker_health))
            if name == M2 and docker_health and calls.count((M2, True)) == 2:
                raise remote.DeployError("not healthy")
            return {}

        with mock.patch.object(remote, "wait_healthy", healthy), self.assertRaises(SystemExit):
            remote.cmd_deploy(self.work)
        self.assertEqual(self.config.read_bytes(), self.config_bytes)
        self.assertEqual(self.runtimes.read_bytes(), self.runtimes_bytes)

    def test_rollback_keeps_registrations_the_manager_added_after_the_deploy(self):
        remote.cmd_deploy(self.work)
        rows = json.loads(self.runtimes.read_text())
        rows["runtimes"].append({"id": "33333333-3333-4333-8333-333333333333", "port": 22009})
        self.runtimes.write_text(json.dumps(rows, separators=(",", ":")) + "\n")
        state = json.loads((self.work / "state.json").read_text())
        state["phase"] = "members"
        remote.rollback(self.work, state)
        restored = json.loads(self.runtimes.read_text())["runtimes"]
        self.assertEqual([row["id"] for row in restored][-1], "33333333-3333-4333-8333-333333333333")
        self.assertTrue(all("patchedFrom" not in row for row in restored))
        self.assertEqual(self.config.read_bytes(), self.config_bytes)


if __name__ == "__main__":
    unittest.main()
