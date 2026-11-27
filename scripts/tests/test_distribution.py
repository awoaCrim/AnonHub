"""Distribution tests run without Docker or production data."""
import base64
import json
import importlib.util
import sys
import time
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import tarfile
import io
import unittest

ROOT = Path(__file__).resolve().parents[2]


def dockerfile_arg(name):
    for line in (ROOT / 'docker/Dockerfile').read_text().splitlines():
        if line.startswith('ARG ' + name + '='):
            return line.split('=', 1)[1]
    raise AssertionError(name)


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.secret = self.directory / 'secret'
        self.secret.write_text('a long test-only password\n')
        self.env = dict(os.environ, KOISHI_STATE_DIR=str(self.directory / 'koishi'),
                        NAPCAT_CONFIG_DIR=str(self.directory / 'napcat'),
                        ADMIN_PASSWORD_FILE=str(self.secret), QQ_ACCOUNT='123456789')

    def initialize(self, **changes):
        return subprocess.run(['node', str(ROOT / 'docker/init.mjs')],
                              env=dict(self.env, **changes), capture_output=True, text=True)

    def module(self, name):
        return json.loads((self.directory / 'koishi/config' / f'{name}.json').read_text())

    def write_module(self, name, value):
        (self.directory / 'koishi/config' / f'{name}.json').write_text(json.dumps(value))

    def test_initialization_prepares_private_wechat_daemon_state(self):
        result = self.initialize(QQ_ACCOUNT='')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = self.directory / 'koishi/data/agent-wechat'
        token = data / 'api-token'
        # agent-wechat refuses a readable data directory or token file, and a token shorter than 32 characters.
        self.assertEqual(stat.S_IMODE(data.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o600)
        secret = token.read_text().strip()
        self.assertRegex(secret, r'^[0-9a-f]{64}$')
        self.assertEqual(self.module('yesimbot-console')['config']['wechat'], {'enabled': True})
        # A restart keeps the token the daemon already trusts.
        self.assertEqual(self.initialize(QQ_ACCOUNT='').returncode, 0)
        self.assertEqual(token.read_text().strip(), secret)

    def test_initialization_and_password_hash(self):
        result = self.initialize()
        self.assertEqual(result.returncode, 0, result.stderr)
        credential = self.directory / 'koishi/data/console-admin/credential.json'
        data = json.loads(credential.read_text())
        salt = base64.b64decode(data['salt'])
        self.assertEqual(len(salt), 16)
        verify = subprocess.run(['node', '-e', "const c=require(process.argv[1]); const h=require('node:crypto').scryptSync('a long test-only password',Buffer.from(c.salt,'base64'),64).toString('base64');process.exit(h===c.hash?0:1)", str(credential)])
        self.assertEqual(verify.returncode, 0)
        self.assertEqual(credential.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.module('adapter-onebot')['config']['selfId'], '123456789')
        self.assertEqual(self.module('yesimbot'), {'enabled': True, 'config': {'allowedChannels': []}})
        self.assertEqual(self.module('yesimbot-model-provider'), {'enabled': True, 'config': {'connections': []}})
        self.assertTrue(self.module('yesimbot-console')['config']['admin']['enabled'])
        self.assertFalse((self.directory / 'koishi/yesimbot-memorizer.json').exists())
        onebot = json.loads((self.directory / 'napcat/onebot11_123456789.json').read_text())
        endpoint = json.loads((self.directory / 'koishi/config/secrets/adapter-onebot.json').read_text())['/path']
        self.assertRegex(endpoint, r'^/onebot/[a-f0-9]{64}$')
        self.assertEqual(onebot['network']['websocketClients'][0]['url'], 'ws://127.0.0.1:5140' + endpoint)
        seed = self.directory / 'koishi/data/onebot/endpoint.json'
        self.assertEqual(json.loads(seed.read_text())['path'], endpoint)
        self.assertEqual(seed.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(endpoint, result.stdout + result.stderr)
        self.assertNotIn('password', result.stdout + result.stderr)

    def test_onebot_endpoint_is_random_per_installation_and_persisted(self):
        self.assertEqual(self.initialize().returncode, 0)
        seed = self.directory / 'koishi/data/onebot/endpoint.json'
        original = seed.read_bytes()
        second_state = self.directory / 'second-koishi'
        second_napcat = self.directory / 'second-napcat'
        result = self.initialize(KOISHI_STATE_DIR=str(second_state), NAPCAT_CONFIG_DIR=str(second_napcat))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(original, (second_state / 'data/onebot/endpoint.json').read_bytes())
        self.secret.unlink()
        self.assertEqual(self.initialize().returncode, 0)
        self.assertEqual(seed.read_bytes(), original)
        # A managed runtime cannot silently adopt a different chat account.
        self.assertNotEqual(self.initialize(QQ_ACCOUNT='987654321').returncode, 0)
        self.assertFalse((self.directory / 'napcat/onebot11_987654321.json').exists())
        self.assertEqual(seed.read_bytes(), original)

    def test_settings_left_in_koishi_yml_are_refused_and_left_alone(self):
        state = self.directory / 'koishi'
        napcat = self.directory / 'napcat'
        state.mkdir()
        napcat.mkdir()
        old_config = 'plugins:\n  adapter-onebot:\n    path: /onebot\n'
        (state / 'koishi.yml').write_text(old_config)
        old_onebot = '{"network":{"websocketClients":[{"url":"ws://127.0.0.1:5140/onebot"}]}}'
        for name in ['onebot11.json', 'onebot11_123456789.json']:
            (napcat / name).write_text(old_onebot)
        result = self.initialize()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('koishi.yml', result.stderr)
        self.assertEqual((state / 'koishi.yml').read_text(), old_config)
        self.assertFalse((state / 'config').exists())
        self.assertEqual(list(state.glob('config.*')), [])
        self.assertFalse((state / 'data/onebot/endpoint.json').exists())
        for name in ['onebot11.json', 'onebot11_123456789.json']:
            self.assertEqual((napcat / name).read_text(), old_onebot)

    def test_public_origin_is_exact_and_seeded_only_when_valid(self):
        for origin in ['https://bot.example.com/path', 'https://user:secret@bot.example.com', 'https://bot.example.com?x=1', 'ftp://bot.example.com', 'https://bot.example.com/']:
            result = self.initialize(ADMIN_PUBLIC_ORIGIN=origin)
            self.assertNotEqual(result.returncode, 0, origin)
            self.assertFalse((self.directory / 'koishi/config').exists())
        result = self.initialize(ADMIN_PUBLIC_ORIGIN='https://bot.example.com')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.module('yesimbot-console')['config']['admin']['publicOrigin'], 'https://bot.example.com')

    def test_tenant_initialization_seeds_only_a_fresh_runtime(self):
        tenant = '11111111-1111-4111-8111-111111111111'
        result = self.initialize(YESIMBOT_TENANT_ID=tenant, ADMIN_PUBLIC_ORIGIN='https://bot.example.com',
                                 ADMIN_ADDITIONAL_ORIGINS_JSON='["http://192.168.1.2:15141"]')
        self.assertEqual(result.returncode, 0, result.stderr)
        files = {p: p.read_bytes() for p in (self.directory / 'koishi/config').rglob('*.json')}
        console = self.module('yesimbot-console')['config']
        self.assertEqual(console['webui'], {'enabled': True})
        self.assertEqual(console['admin']['additionalOrigins'], ['http://192.168.1.2:15141'])
        self.assertNotIn('accounts', console)
        self.assertEqual(self.module('yesimbot-model-provider'), {'enabled': True, 'config': {'connections': []}})
        self.assertEqual(self.module('yesimbot')['config']['allowedChannels'], [])
        self.assertEqual(self.initialize(YESIMBOT_TENANT_ID=tenant, ADMIN_PUBLIC_ORIGIN='https://other.example.com').returncode, 0)
        self.assertEqual(files, {p: p.read_bytes() for p in files})

    def test_local_device_gateway_is_added_to_existing_managed_runtime(self):
        tenant = '11111111-1111-4111-8111-111111111111'
        credential = self.directory / 'device-credential.json'
        credential.write_text(json.dumps({'version': 1, 'tenantId': tenant, 'token': 'a' * 64}))
        base = dict(YESIMBOT_TENANT_ID=tenant, ADMIN_PUBLIC_ORIGIN='https://bot.example.com', YESIMBOT_DEVICE_GATEWAY='https://gateway.example.com', YESIMBOT_DEVICE_CREDENTIAL_FILE=str(credential))
        self.assertEqual(self.initialize(**base).returncode, 0)
        config = self.directory / 'koishi/config'
        snapshot = lambda: {p.relative_to(config): p.read_bytes() for p in config.rglob('*.json')}
        self.assertNotIn('localGateway', self.module('yesimbot-device-connection')['config'])
        # The manager recreates the container with the bridge address: the existing settings gain it, nothing else changes.
        before = snapshot()
        result = self.initialize(**base, YESIMBOT_DEVICE_LOCAL_GATEWAY='http://172.19.0.1:17401')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.module('yesimbot-device-connection'), {'enabled': True, 'config': {
            'gateway': 'https://gateway.example.com', 'localGateway': 'http://172.19.0.1:17401', 'credentialFile': str(credential)}})
        after = snapshot()
        device = Path('yesimbot-device-connection.json')
        self.assertEqual({k: v for k, v in after.items() if k != device}, {k: v for k, v in before.items() if k != device})
        self.assertEqual(self.initialize(**base, YESIMBOT_DEVICE_LOCAL_GATEWAY='http://172.19.0.1:17401').returncode, 0)
        self.assertEqual(snapshot(), after)
        # Taken away again when the manager stops passing it.
        self.assertEqual(self.initialize(**base).returncode, 0)
        self.assertNotIn('localGateway', self.module('yesimbot-device-connection')['config'])
        for bad in ['https://172.19.0.1:17401', 'http://172.19.0.1', 'http://8.8.8.8:17401', 'http://example.com:17401', 'http://172.19.0.1:17401/x']:
            self.assertNotEqual(self.initialize(**base, YESIMBOT_DEVICE_LOCAL_GATEWAY=bad).returncode, 0, bad)
        self.assertNotEqual(self.initialize(YESIMBOT_TENANT_ID=tenant, ADMIN_PUBLIC_ORIGIN='https://bot.example.com', YESIMBOT_DEVICE_LOCAL_GATEWAY='http://172.19.0.1:17401').returncode, 0)

    def test_retired_computer_assignment_is_ignored_for_fresh_runtime(self):
        tenant = '11111111-1111-4111-8111-111111111111'
        assigned = self.directory / 'computer.json'
        assigned.write_text(json.dumps({'version': 1, 'deviceId': '33333333-3333-4333-8333-333333333333'}))
        result = self.initialize(YESIMBOT_TENANT_ID=tenant, ADMIN_PUBLIC_ORIGIN='https://bot.example.com', YESIMBOT_COMPUTER_FILE=str(assigned))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.directory / 'koishi/config/yesimbot-workspace.json').exists())
        self.assertFalse((self.directory / 'koishi/data/managed-computer.json').exists())
        self.assertEqual(json.loads(assigned.read_text())['deviceId'], '33333333-3333-4333-8333-333333333333')

    def test_retired_computer_assignment_preserves_existing_external_workspace_and_pairing(self):
        tenant = '11111111-1111-4111-8111-111111111111'
        external = '33333333-3333-4333-8333-333333333333'
        assigned = self.directory / 'computer.json'
        credential = self.directory / 'device-credential.json'
        credential.write_text(json.dumps({'version': 1, 'tenantId': tenant, 'token': 'a' * 64}))
        base = dict(YESIMBOT_TENANT_ID=tenant, ADMIN_PUBLIC_ORIGIN='https://bot.example.com', YESIMBOT_DEVICE_GATEWAY='https://gateway.example.com', YESIMBOT_DEVICE_CREDENTIAL_FILE=str(credential))
        self.assertEqual(self.initialize(**base).returncode, 0)
        self.write_module('yesimbot-workspace', {'enabled': True, 'config': {
            'storage': {'kind': 'device', 'deviceId': external},
            'computer': {'deviceId': external},
        }})
        state = self.directory / 'koishi/data/managed-computer.json'
        state.write_text(json.dumps({'version': 1, 'deviceId': external}))
        workspace = self.directory / 'koishi/config/yesimbot-workspace.json'
        originals = {path: path.read_bytes() for path in [workspace, credential, state]}
        for contents in [json.dumps({'version': 1, 'deviceId': '44444444-4444-4444-8444-444444444444'}), '{invalid legacy assignment']:
            assigned.write_text(contents)
            result = self.initialize(**base, YESIMBOT_COMPUTER_FILE=str(assigned))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual({path: path.read_bytes() for path in originals}, originals)
            self.assertEqual(assigned.read_text(), contents)

    def test_existing_settings_are_not_implicitly_changed(self):
        tenant = '11111111-1111-4111-8111-111111111111'
        environment = {'YESIMBOT_TENANT_ID': tenant, 'ADMIN_PUBLIC_ORIGIN': 'https://bot.example.com'}
        self.assertEqual(self.initialize(**environment).returncode, 0)
        # A disabled model provider stays disabled, a console without its WebUI stays so.
        provider = self.module('yesimbot-model-provider')
        self.write_module('yesimbot-model-provider', {**provider, 'enabled': False})
        console = self.module('yesimbot-console')
        console['config']['webui'] = {'enabled': False}
        self.write_module('yesimbot-console', console)
        config = self.directory / 'koishi/config'
        originals = {p: p.read_bytes() for p in config.rglob('*.json')}
        self.secret.unlink()
        result = self.initialize(**environment, QQ_ACCOUNT='')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({p: p.read_bytes() for p in originals}, originals)

    def test_invalid_tenant_or_additional_origins_fails_before_writes(self):
        for changes in [
            {'YESIMBOT_TENANT_ID': '../owner'},
            {'YESIMBOT_TENANT_ID': '11111111-1111-4111-8111-111111111111'},
            {'ADMIN_ADDITIONAL_ORIGINS_JSON': '{}'},
            {'ADMIN_ADDITIONAL_ORIGINS_JSON': '["https://bad.example/path"]', 'ADMIN_PUBLIC_ORIGIN': 'https://bot.example'},
            {'ADMIN_ADDITIONAL_ORIGINS_JSON': '["https://ok.example"]'},
        ]:
            self.assertNotEqual(self.initialize(**changes).returncode, 0)
            self.assertFalse((self.directory / 'koishi').exists())

    def test_owner_gets_the_webui_and_keeps_it_when_tenant_settings_arrive(self):
        self.assertEqual(self.initialize().returncode, 0)
        console = self.directory / 'koishi/config/yesimbot-console.json'
        original = console.read_bytes()
        self.assertEqual(json.loads(original)['config']['webui'], {'enabled': True})
        self.assertEqual(self.initialize(YESIMBOT_TENANT_ID='11111111-1111-4111-8111-111111111111', ADMIN_PUBLIC_ORIGIN='https://bot.example').returncode, 0)
        self.assertEqual(console.read_bytes(), original)

    def test_idempotency_preserves_all_existing_files_without_secret(self):
        self.assertEqual(self.initialize().returncode, 0)
        files = {p: p.read_bytes() for p in self.directory.rglob('*') if p.is_file() and p != self.secret}
        self.secret.unlink()
        result = self.initialize(QQ_ACCOUNT='')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(files, {p: p.read_bytes() for p in files})

    def test_missing_password_or_invalid_account_fails_closed(self):
        self.secret.unlink()
        self.assertNotEqual(self.initialize().returncode, 0)
        self.assertFalse((self.directory / 'koishi/config').exists())
        self.secret.write_text('short')
        self.assertNotEqual(self.initialize().returncode, 0)
        self.secret.write_text('another long test password')
        self.assertNotEqual(self.initialize(QQ_ACCOUNT='not-an-account').returncode, 0)

    def test_runtime_packaging_preserves_workspace_links_and_excludes_private_files(self):
        fixture = self.directory / 'source'
        fixture.mkdir()
        (fixture / 'package.json').write_text(json.dumps({'workspaces': ['core', 'platforms/*', 'docker/app']}))
        (fixture / 'yarn.lock').write_text('locked')
        (fixture / '.yarnrc.yml').write_text('nodeLinker: node-modules')
        (fixture / '.yarn/releases').mkdir(parents=True)
        (fixture / '.yarn/releases/yarn-4.12.0.cjs').write_text('yarn')
        (fixture / 'node_modules').mkdir()
        (fixture / 'node_modules/koishi-plugin-test').symlink_to('../core', target_is_directory=True)
        for directory in ['core', 'docker/app']:
            target = fixture / directory
            (target / 'dist').mkdir(parents=True)
            (target / 'package.json').write_text('{}')
            (target / 'dist/index.js').write_text('built')
            (target / '.env').write_text('PRIVATE_SECRET=do-not-bundle')
        (fixture / 'data').mkdir()
        (fixture / 'data/private-history').write_text('private')
        result = subprocess.run(['node', str(ROOT / 'docker/prepare-runtime.mjs')], cwd=fixture, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        runtime = fixture / 'runtime'
        self.assertEqual(os.readlink(runtime / 'node_modules/koishi-plugin-test'), '../core')
        self.assertEqual((runtime / 'node_modules/koishi-plugin-test/dist/index.js').read_text(), 'built')
        self.assertFalse((runtime / 'core/.env').exists())
        self.assertFalse((runtime / 'data').exists())

    def bootstrap_fixture(self):
        binaries = self.directory / 'bootstrap-bin'
        binaries.mkdir()
        for name, body in {
            'uname': '#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo x86_64\n',
            'docker': '#!/bin/sh\nexit 0\n',
            'curl': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOWNLOAD_LOG"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then cp "$SOURCE_ARCHIVE" "$2"; exit; fi; shift; done\nexit 1\n',
        }.items():
            executable = binaries / name
            executable.write_text(body)
            executable.chmod(0o700)
        archive = self.directory / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            for name, body in {
                'repo/scripts/install-linux.sh': '#!/bin/bash\nset -eu\nroot=$(cd "$(dirname "$0")/.." && pwd)\nprintf "called\\n" >> "$root/calls"\ntest -f "$root/preserved" || echo original > "$root/preserved"\n',
                'repo/compose.yaml': 'services: {}',
                'repo/package.json': '{}',
            }.items():
                item = tarfile.TarInfo(name)
                content = body.encode()
                item.size = len(content)
                output.addfile(item, io.BytesIO(content))
        installation = self.directory.resolve() / 'installation'
        env = dict(os.environ, PATH=f'{binaries}:{os.environ["PATH"]}', SOURCE_ARCHIVE=str(archive),
                   DOWNLOAD_LOG=str(self.directory / 'download.log'), YESIMBOT_INSTALL_DIR=str(installation))
        return archive, installation, env

    def test_bootstrap_download_extract_and_idempotent_reuse(self):
        archive, installation, env = self.bootstrap_fixture()
        command = ['bash', str(ROOT / 'scripts/bootstrap-linux.sh'), '--check']
        first = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual((installation / '.yesimbot-source').read_text(), 'awoaCrim/AnonHub@main\n')
        (installation / 'preserved').write_text('user-state')
        archive.unlink()
        second = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual((installation / 'preserved').read_text(), 'user-state')
        self.assertEqual((installation / 'calls').read_text().count('called'), 2)
        self.assertEqual((self.directory / 'download.log').read_text().count('--output'), 1)

    def test_bootstrap_rejects_arbitrary_directories_urls_refs_and_paths(self):
        _, installation, env = self.bootstrap_fixture()
        command = ['bash', str(ROOT / 'scripts/bootstrap-linux.sh'), '--check']
        installation.mkdir()
        (installation / 'private').write_text('keep')
        self.assertNotEqual(subprocess.run(command, env=env, capture_output=True).returncode, 0)
        self.assertEqual((installation / 'private').read_text(), 'keep')
        for changes in [
            {'YESIMBOT_SOURCE_REPO': 'https://user:secret@example.com/repo'},
            {'YESIMBOT_SOURCE_REF': '../escape'},
            {'YESIMBOT_SOURCE_REF': 'main;touch-pwned'},
            {'YESIMBOT_INSTALL_DIR': str(installation / '../escape')},
            {'YESIMBOT_INSTALL_DIR': '/'},
        ]:
            self.assertNotEqual(subprocess.run(command, env=dict(env, **changes), capture_output=True).returncode, 0, changes)
        link = self.directory / 'symlink'
        link.symlink_to(installation, target_is_directory=True)
        self.assertNotEqual(subprocess.run(command, env=dict(env, YESIMBOT_INSTALL_DIR=str(link.resolve().parent / link.name)), capture_output=True).returncode, 0)
        self.assertFalse((self.directory / 'download.log').exists())

    def test_bootstrap_rejects_archive_traversal_and_links(self):
        archive, installation, env = self.bootstrap_fixture()
        command = ['bash', str(ROOT / 'scripts/bootstrap-linux.sh'), '--check']
        for name, kind in [('repo/../../escaped', tarfile.REGTYPE), ('repo/link', tarfile.SYMTYPE)]:
            with tarfile.open(archive, 'w:gz') as output:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
                output.addfile(entry)
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(installation.exists())
            self.assertFalse((self.directory / 'escaped').exists())

    def test_installer_prerequisite_and_help_smoke(self):
        result = subprocess.run(['bash', str(ROOT / 'scripts/install-linux.sh'), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('--password-file', result.stdout)
        subprocess.run(['bash', '-n', str(ROOT / 'scripts/install-linux.sh')], check=True)
        subprocess.run(['sh', '-n', str(ROOT / 'docker/entrypoint.sh')], check=True)
        subprocess.run(['bash', '-n', str(ROOT / 'docker/start-napcat.sh')], check=True)

    def test_explicit_qq_logout_suppresses_forced_login_on_subsequent_start(self):
        # Capture the environment at the real wrapper's exec boundary.
        # Do not launch QQ or replace the wrapper's logout decision.
        shim = self.directory / 'capture-exec.bash'
        keys = ['ACCOUNT', 'NAPCAT_QUICK_ACCOUNT', 'NAPCAT_QUICK_PASSWORD', 'NAPCAT_QUICK_PASSWORD_MD5', 'NAPCAT_CONFIG_DIR']
        program = 'import os,json;print(json.dumps({k:os.environ.get(k) for k in ' + repr(keys) + '}))'
        import shlex
        shim.write_text('exec() { ' + shlex.quote(sys.executable) + ' -c ' + shlex.quote(program) + '; }\n')
        config = self.directory / 'napcat'
        config.mkdir()
        env = dict(self.env, BASH_ENV=str(shim), ACCOUNT='123456789',
                   NAPCAT_QUICK_ACCOUNT='987654321', NAPCAT_QUICK_PASSWORD='fixture-only',
                   NAPCAT_QUICK_PASSWORD_MD5='f' * 32)
        def launch():
            result = subprocess.run(['bash', str(ROOT / 'docker/start-napcat.sh')], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        before = launch()
        for key in keys:
            self.assertEqual(before[key], env[key])
        marker = config / 'yesimbot-logged-out'
        marker.write_text('{}\n')
        for _ in range(2):
            after = launch()
            self.assertEqual(after['ACCOUNT'], '')
            for key in keys[1:4]:
                self.assertIsNone(after[key])
            self.assertEqual(after['NAPCAT_CONFIG_DIR'], str(config))
            self.assertEqual(marker.read_text(), '{}\n')

    def test_installer_repeated_source_build_preserves_credentials(self):
        checkout = self.directory / 'checkout'
        (checkout / 'scripts').mkdir(parents=True)
        shutil.copy(ROOT / 'scripts/install-linux.sh', checkout / 'scripts')
        shutil.copy(ROOT / 'compose.yaml', checkout)
        binaries = self.directory / 'bin'
        binaries.mkdir()
        mocks = {
            'uname': '#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo x86_64\n',
            'stat': '#!/bin/sh\n[ "$2" = %a ] && echo 600 || id -u\n',
            'docker': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_LOG"\ncase "$*" in *"up -d"*) mkdir -p "$MOCK_DATA/koishi/data/console-admin"; test -f "$MOCK_DATA/koishi/data/console-admin/credential.json" || echo preserved > "$MOCK_DATA/koishi/data/console-admin/credential.json";; esac\n',
        }
        for name, body in mocks.items():
            file = binaries / name
            file.write_text(body)
            file.chmod(0o700)
        data = self.directory / 'data'
        log = self.directory / 'docker.log'
        env = dict(os.environ, PATH=f'{binaries}:{os.environ["PATH"]}', MOCK_LOG=str(log), MOCK_DATA=str(data))
        command = ['bash', str(checkout / 'scripts/install-linux.sh'), '--password-file', str(self.secret), '--data-dir', str(data), '--public-origin', 'https://bot.example.com']
        first = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.secret.unlink()
        second = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual((data / 'koishi/data/console-admin/credential.json').read_text(), 'preserved\n')
        self.assertEqual((data / 'admin-password').read_text(), '')
        self.assertEqual(log.read_text().count('up -d --build --wait'), 2)
        self.assertIn('ADMIN_PUBLIC_ORIGIN=https://bot.example.com', (checkout / '.env.single').read_text())
        # QQ and WeChat are signed in from the console afterwards; installing asks for neither.
        self.assertNotIn('QQ', (checkout / '.env.single').read_text())
        self.assertNotEqual(subprocess.run(command + ['--qq-account', '123456789'], env=env, capture_output=True, text=True).returncode, 0)
        invalid = subprocess.run(command + ['--public-origin', 'https://user:secret@bot.example.com/path'], env=env, capture_output=True, text=True)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertEqual(log.read_text().count('up -d --build --wait'), 2)
        self.assertNotIn('a long test-only password', first.stdout + first.stderr + log.read_text())

    @unittest.skipUnless(importlib.util.find_spec('supervisor'), 'optional supervisor package is unavailable')
    def test_live_supervisor_stops_both_process_groups_and_bounds_retries(self):
        import configparser
        config = configparser.ConfigParser(interpolation=None)
        config.read(ROOT / 'docker/supervisord.conf')
        socket = self.directory / 'supervisor.sock'
        config['supervisord']['pidfile'] = str(self.directory / 'supervisor.pid')
        config['unix_http_server']['file'] = str(socket)
        config['supervisorctl']['serverurl'] = 'unix://' + str(socket)
        child = self.directory / 'child.py'
        child.write_text('import os, signal, sys, time\nfrom pathlib import Path\nname=sys.argv[1]\npid=os.fork()\nrole="child" if pid==0 else "parent"\ndef stop(*args):\n Path(name+"-"+role+"-stopped").touch()\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nPath(name+"-"+role+"-ready").touch()\nwhile True: time.sleep(0.1)\n')
        for name in ['napcat', 'agent-wechat', 'koishi']:
            service = config[f'program:{name}']
            service['command'] = f'{sys.executable} {child} {self.directory / name}'
            service['directory'] = str(self.directory)
            service['startsecs'] = '1'
            service['stopwaitsecs'] = '3'
            service['stdout_logfile'] = '/dev/null'
            service['stderr_logfile'] = '/dev/null'
            service.pop('environment', None)
        failure = self.directory / 'failure.py'
        failure.write_text('from pathlib import Path\np=Path("attempts")\np.write_text(p.read_text()+"x" if p.exists() else "x")\nraise SystemExit(1)\n')
        config['program:failure'] = dict(config['program:koishi'])
        config['program:failure']['command'] = f'{sys.executable} {failure}'
        file = self.directory / 'supervisord.conf'
        with file.open('w') as stream:
            config.write(stream)
        process = subprocess.Popen([sys.executable, '-m', 'supervisor.supervisord', '-c', str(file)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env=dict(os.environ, NAPCAT_AUTOSTART='true', WECHAT_AUTOSTART='true', KOISHI_STATE_DIR=str(self.directory)))
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                attempts = self.directory / 'attempts'
                ready = all((self.directory / f'{name}-{role}-ready').exists() for name in ['napcat', 'agent-wechat', 'koishi'] for role in ['parent', 'child'])
                if ready and attempts.exists() and len(attempts.read_text()) == 4:
                    break
                time.sleep(0.1)
            self.assertTrue(ready)
            self.assertEqual(attempts.read_text(), 'xxxx')
            time.sleep(1)
            self.assertEqual(attempts.read_text(), 'xxxx')
        finally:
            process.terminate()
            process.wait(timeout=10)
        for name in ['napcat', 'agent-wechat', 'koishi']:
            for role in ['parent', 'child']:
                self.assertTrue((self.directory / f'{name}-{role}-stopped').exists(), (name, role))

    def test_runtime_image_repairs_qq_before_installing_new_tools(self):
        # Execute the actual runtime-base RUN with an apt boundary fixture:
        # --fix-broken may repair the pre-existing QQ gap, but cannot introduce
        # the new tools' transitive dependencies in the same transaction.
        dockerfile = (ROOT / 'docker/Dockerfile').read_text()
        command = dockerfile.split('RUN ', 1)[1].split('\n\n', 1)[0].replace('\\\n', ' ')
        binaries = self.directory / 'apt-bin'
        binaries.mkdir()
        apt = binaries / 'apt-get'
        apt.write_text("""#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$APT_LOG"
case "$1" in
 update) exit 0;;
 install)
  case " $* " in *' --no-remove '*) ;; *) exit 71;; esac
  case " $* " in
   *' --fix-broken '*)
    case " $* " in *' openssh-client '*|*' supervisor '*) exit 72;; esac
    for last do :; done; test "$last" = xdg-utils
    touch "$APT_REPAIRED";;
   *) test -f "$APT_REPAIRED";;
  esac;;
 check) test -f "$APT_REPAIRED";;
 *) exit 73;;
esac
""")
        apt.chmod(0o700)
        # Prevent cleanup from touching the real machine when replaying RUN.
        cleanup = binaries / 'rm'
        cleanup.write_text('#!/bin/sh\nexit 0\n')
        cleanup.chmod(0o700)
        env = dict(os.environ, PATH=f'{binaries}:{os.environ["PATH"]}',
                   APT_LOG=str(self.directory / 'apt.log'), APT_REPAIRED=str(self.directory / 'repaired'))
        result = subprocess.run(['sh', '-c', command], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.directory / 'apt.log').read_text().splitlines()
        self.assertEqual(len(calls), 4)
        self.assertIn('--fix-broken xdg-utils', calls[1])
        self.assertNotIn('--fix-broken', calls[2])
        self.assertIn('openssh-client', calls[2])
        self.assertEqual(calls[3], 'check')

    def test_supervisor_and_exposure_contract(self):
        import configparser
        config = configparser.ConfigParser(interpolation=None)
        config.read(ROOT / 'docker/supervisord.conf')
        for name in ['koishi', 'napcat']:
            service = config[f'program:{name}']
            self.assertEqual(service['stopasgroup'], 'true')
            self.assertEqual(service['killasgroup'], 'true')
            self.assertEqual(service['autorestart'], 'false')
            self.assertEqual(service['startretries'], '3')
        self.assertEqual(config['program:napcat']['directory'], '/app')
        self.assertEqual(config['program:napcat']['command'], '/bin/bash /opt/yesimbot/docker/start-napcat.sh')
        compose = (ROOT / 'compose.yaml').read_text()
        self.assertNotIn(':6099', compose)
        dockerfile = (ROOT / 'docker/Dockerfile').read_text()
        self.assertIn('install --immutable', dockerfile)
        self.assertIn('tini', (ROOT / 'docker/entrypoint.sh').read_text())

    def test_one_account_as_separate_containers_on_one_network(self):
        # leave-koishi 6.7: only `net` publishes; the others join it and reach each other on loopback.
        compose = (ROOT / 'compose.yaml').read_text()
        services, current = {}, None
        for line in compose.split('\nservices:\n', 1)[1].split('\nsecrets:\n', 1)[0].splitlines():
            if line.startswith('  ') and not line.startswith('   ') and line.endswith(':'):
                current = line.strip().rstrip(':')
                services[current] = ''
            elif current and line.startswith('    '):
                services[current] += line.strip() + '\n'
        self.assertEqual(sorted(services), ['app', 'napcat', 'net', 'wechat'])
        self.assertEqual(compose.count('ports:'), 1)
        self.assertIn('ports:', services['net'])
        for name in ['app', 'napcat', 'wechat']:
            self.assertIn('network_mode: service:net', services[name])
        self.assertIn('target: app', services['app'])
        self.assertIn('target: wechat', services['net'])
        # NapCat is the same pinned upstream image the combined image starts from, unmodified.
        pin = dockerfile_arg('NAPCAT_IMAGE')
        self.assertIn('image: ' + pin, services['napcat'])
        self.assertNotIn('build:', services['napcat'])
        self.assertIn('./docker/start-napcat.sh:/opt/yesimbot/start-napcat.sh:ro', services['napcat'])
        # NapCat's output carries login QR codes and tokens; agent-wechat's stdout carries chat contents.
        self.assertIn('driver: none', services['napcat'])
        self.assertIn('>/dev/null', (ROOT / 'docker/start-wechat.sh').read_text().splitlines()[-1])
        # The app holds no QQ data; agent-wechat only its own directory.
        self.assertNotIn('/app/.config/QQ', services['app'])
        self.assertIn('/koishi/data/agent-wechat:/var/lib/yesimbot/data/agent-wechat', services['wechat'])
        dockerfile = (ROOT / 'docker/Dockerfile').read_text()
        stages = {line.split(' AS ')[1].strip(): line for line in dockerfile.splitlines() if line.startswith('FROM ') and ' AS ' in line}
        self.assertEqual(stages['app-base'], 'FROM node-runtime AS app-base')
        self.assertEqual(stages['wechat'], 'FROM node-runtime AS wechat')
        # The combined image (host, NapCat and agent-wechat) is what production runs: the default target.
        self.assertEqual([line for line in dockerfile.splitlines() if line.startswith('FROM ')][-1], 'FROM runtime-base')

    def test_app_image_leaves_qq_and_wechat_to_their_own_containers(self):
        entrypoint = (ROOT / 'docker/entrypoint.sh').read_text()
        self.assertIn('if [ "${YESIMBOT_IMAGE:-}" = app ]; then\n  export NAPCAT_AUTOSTART=false WECHAT_AUTOSTART=false', entrypoint)
        healthcheck = (ROOT / 'docker/healthcheck.mjs').read_text()
        self.assertIn('process.env.YESIMBOT_IMAGE !== "app"', healthcheck)
        import configparser
        config = configparser.ConfigParser(interpolation=None)
        config.read(ROOT / 'docker/supervisord.conf')
        self.assertEqual(config['program:agent-wechat']['autostart'], '%(ENV_WECHAT_AUTOSTART)s')
        self.assertEqual(config['program:koishi']['command'], '/bin/sh /opt/yesimbot/docker/start-host.sh')
        subprocess.run(['sh', '-n', str(ROOT / 'docker/start-host.sh')], check=True)
        subprocess.run(['sh', '-n', str(ROOT / 'docker/start-wechat.sh')], check=True)
        self.assertIn('exec /usr/local/bin/node /opt/yesimbot/apps/server/dist/main.js --state "${KOISHI_STATE_DIR:-/var/lib/yesimbot}"',
                      (ROOT / 'docker/start-host.sh').read_text())

    def test_new_host_state_is_config_files_with_the_onebot_path_secret(self):
        result = self.initialize()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.directory / 'koishi'
        self.assertFalse((state / 'koishi.yml').exists())
        self.assertFalse((state / 'package.json').exists())
        config = state / 'config'
        self.assertEqual(sorted(p.name for p in config.iterdir()), ['adapter-onebot.json', 'app.json', 'secrets', 'yesimbot-console.json', 'yesimbot-model-provider.json', 'yesimbot.json'])
        self.assertEqual(stat.S_IMODE((config / 'secrets').stat().st_mode), 0o700)
        for file in [*config.glob('*.json'), *config.glob('secrets/*.json')]:
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600, file)
        self.assertEqual(json.loads((config / 'app.json').read_text()), {'server': {'host': '0.0.0.0', 'port': 5140}})
        onebot = json.loads((config / 'adapter-onebot.json').read_text())
        self.assertEqual(onebot, {'enabled': True, 'config': {'selfId': '123456789', 'protocol': 'ws-reverse', 'path': {'$secret': '/path'}}})
        secret = json.loads((config / 'secrets/adapter-onebot.json').read_text())['/path']
        self.assertRegex(secret, r'^/onebot/[a-f0-9]{64}$')
        napcat = json.loads((self.directory / 'napcat/onebot11.json').read_text())
        self.assertEqual(napcat['network']['websocketClients'][0]['url'], 'ws://127.0.0.1:5140' + secret)
        console = json.loads((config / 'yesimbot-console.json').read_text())['config']
        self.assertEqual(console['napcat'], {'enabled': True, 'endpoint': 'http://127.0.0.1:6099', 'webuiConfigFile': '/app/napcat/config/webui.json'})
        self.assertEqual(console['admin']['credentialFile'], 'data/console-admin/credential.json')
        self.assertTrue((state / 'data/console-admin/credential.json').exists())
        self.assertTrue((state / 'data/agent-wechat/api-token').exists())
        # A second start keeps every file as it is.
        before = {p: p.read_bytes() for p in config.rglob('*.json')}
        self.assertEqual(self.initialize().returncode, 0)
        self.assertEqual(before, {p: p.read_bytes() for p in config.rglob('*.json')})

    @unittest.skipUnless(shutil.which('node'), 'node is not installed')
    def test_images_before_6_7_start_the_host_through_start_koishi(self):
        launcher = str(ROOT / 'docker/start-koishi.cjs')
        with tempfile.TemporaryDirectory() as state:
            # Their supervisord runs `start-koishi.cjs start koishi.yml`; a marker left by stage 7 changes nothing.
            for marker in (None, 'server\n', 'koishi\n'):
                if marker is not None:
                    Path(state, '.yesimbot-host').write_text(marker)
                run = subprocess.run(['node', launcher, 'start', 'koishi.yml'], env=dict(os.environ, KOISHI_STATE_DIR=state), capture_output=True, text=True, timeout=30)
                # The host's entry in the image (absent here) is what it loads.
                self.assertEqual(run.returncode, 1)
                self.assertIn('/opt/yesimbot/apps/server/dist/main.js', run.stderr)

    def test_distribution_offers_qq_login_without_a_qq_number(self):
        # compose.yaml runs NapCat beside the app with no account: the console signs QQ in, the connector takes that QQ.
        result = self.initialize(QQ_ACCOUNT='', NAPCAT_BESIDE='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.directory / 'koishi/config'
        onebot = json.loads((config / 'adapter-onebot.json').read_text())
        self.assertEqual(onebot, {'enabled': True, 'config': {'protocol': 'ws-reverse', 'path': {'$secret': '/path'}}})
        path = json.loads((config / 'secrets/adapter-onebot.json').read_text())['/path']
        self.assertRegex(path, r'^/onebot/[a-f0-9]{64}$')
        self.assertTrue(json.loads((config / 'yesimbot-console.json').read_text())['config']['napcat']['enabled'])
        # NapCat copies onebot11.json for whichever QQ signs in first.
        napcat = self.directory / 'napcat'
        template = json.loads((napcat / 'onebot11.json').read_text())
        self.assertEqual(template['network']['websocketClients'][0]['url'], 'ws://127.0.0.1:5140' + path)
        self.assertEqual(sorted(p.name for p in napcat.glob('onebot11_*.json')), [])
        compose = (ROOT / 'compose.yaml').read_text()
        self.assertIn('NAPCAT_BESIDE: "1"', compose)
        self.assertNotIn('QQ_ACCOUNT', compose)

    def test_new_host_adopts_a_later_qq_account_and_device_gateway(self):
        self.assertEqual(self.initialize(QQ_ACCOUNT='').returncode, 0)
        config = self.directory / 'koishi/config'
        self.assertFalse((config / 'adapter-onebot.json').exists())
        console = json.loads((config / 'yesimbot-console.json').read_text())
        console['config']['webui']['extra'] = 'kept'
        (config / 'yesimbot-console.json').write_text(json.dumps(console))
        credential = self.directory / 'device.json'
        credential.write_text(json.dumps({'version': 1, 'tenantId': '', 'token': 'c' * 64}))
        gateway = dict(YESIMBOT_DEVICE_GATEWAY='https://devices.example', YESIMBOT_DEVICE_CREDENTIAL_FILE=str(credential))
        result = self.initialize(**gateway)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((config / 'adapter-onebot.json').read_text())['config']['selfId'], '123456789')
        self.assertRegex(json.loads((config / 'secrets/adapter-onebot.json').read_text())['/path'], r'^/onebot/[a-f0-9]{64}$')
        console = json.loads((config / 'yesimbot-console.json').read_text())['config']
        self.assertTrue(console['napcat']['enabled'])
        self.assertEqual(console['webui']['extra'], 'kept')
        device = json.loads((config / 'yesimbot-device-connection.json').read_text())
        self.assertEqual(device, {'enabled': True, 'config': {'gateway': 'https://devices.example', 'credentialFile': str(credential)}})
        managed = json.loads((self.directory / 'koishi/data/managed-connectors.json').read_text())
        self.assertEqual((managed['qqAccount'], managed['gateway']), ('123456789', 'https://devices.example'))
        self.assertEqual(self.initialize().returncode, 0)
        self.assertFalse((config / 'yesimbot-device-connection.json').exists())


if __name__ == '__main__':
    unittest.main()
