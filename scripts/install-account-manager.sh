#!/usr/bin/env bash
# Installs only the host manager. Restarting the owner's host is an explicit ops step.
set -euo pipefail
umask 077
usage() {
  cat <<'HELP'
Usage: sudo bash scripts/install-account-manager.sh --config ROOT_JSON --owner-state ABSOLUTE_DIR [--activate-owner-config JSON_FILE]
Requires Linux amd64, systemd, Docker Engine with iptables DOCKER-USER, and a locally built trusted combined image.
ROOT_JSON selects rootDir, tokenFile, bindHost, port, image, publicOrigin, additionalOrigins, reservedOwnerQQ and caps.
With pod {app, napcat, wechat}, new accounts run as separate containers from those images (all must exist locally).
Managed cloud computer provisioning is retired; use an existing paired device.
Node >=22 is used if present, otherwise /usr/local/bin/node is extracted from that fixed image without starting it.
Copies the manager capability to OWNER_STATE/data/console-admin/runtime-manager.key (0600).
Optional activation patches only `accounts` in the owner's console settings (JSON_FILE: OWNER_STATE/config/yesimbot-console.json)
after authenticated manager health. No app or QQ restart is performed.
HELP
}
config= owner_state= activate=
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0;;
    --config|--owner-state|--activate-owner-config)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in --config) config=$2;; --owner-state) owner_state=$2;; *) activate=$2;; esac
      shift 2;;
    *) usage >&2; exit 2;;
  esac
done
[[ $(id -u) == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Root Linux amd64 is required.' >&2; exit 1; }
[[ -n $config && -n $owner_state && $config = /* && $owner_state = /* ]] || { usage >&2; exit 2; }
for tool in docker systemctl iptables python3; do command -v "$tool" >/dev/null || { echo 'Missing host prerequisite.' >&2; exit 1; }; done
# Validate paths and the private config before trusting any supplied image name.
images=$(python3 - "$config" "$owner_state" "$activate" <<'PY'
import json,os,re,stat,sys
from pathlib import Path
for value in filter(None,sys.argv[1:]):
 p=Path(value)
 if not p.is_absolute() or '..' in p.parts or any(x in value for x in '\n\r,:'): raise SystemExit('Invalid private path.')
 for part in [p,*p.parents]:
  if part.is_symlink(): raise SystemExit('Symlink paths are forbidden.')
s=Path(sys.argv[1]).stat()
if s.st_uid!=0 or stat.S_IMODE(s.st_mode)&0o077: raise SystemExit('Config must be root-owned 0600.')
c=json.loads(Path(sys.argv[1]).read_text())
if not isinstance(c,dict) or 'computer' in c: raise SystemExit('Managed cloud computer provisioning is retired.')
pod=c.get('pod') or {}
images=[c.get('image','')]+[pod.get(k,'') for k in ('app','napcat','wechat') if 'pod' in c]
if not all(isinstance(i,str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}',i) for i in images): raise SystemExit('Invalid image.')
print('\n'.join(images))
PY
)
mapfile -t images <<<"$images"
image=${images[0]}
for each in "${images[@]}"; do
  docker image inspect "$each" >/dev/null 2>&1 || { echo 'Fixed trusted image is unavailable.' >&2; exit 1; }
done
iptables -w -S DOCKER-USER >/dev/null 2>&1 || { echo 'Docker iptables DOCKER-USER is required.' >&2; exit 1; }
install_dir=/opt/yesimbot-account-manager
install -d -m 700 "$install_dir"
node_bin=$(command -v node || true)
if [[ -z $node_bin ]] || ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' >/dev/null 2>&1; then
  node_container=$(docker create --network none --entrypoint /usr/local/bin/node "$image")
  trap 'docker rm "$node_container" >/dev/null 2>&1 || true' EXIT
  docker cp "$node_container:/usr/local/bin/node" "$install_dir/node.candidate" >/dev/null 2>&1
  chmod 700 "$install_dir/node.candidate"
  "$install_dir/node.candidate" -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' >/dev/null 2>&1 || { echo 'Image Node binary is incompatible with this host.' >&2; exit 1; }
  mv "$install_dir/node.candidate" "$install_dir/node"
  node_bin=$install_dir/node
  docker rm "$node_container" >/dev/null
  trap - EXIT
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -m 600 "$source_dir/runtime-manager.mjs" "$install_dir/runtime-manager.mjs"
install -m 600 "$source_dir/runtime-pod.mjs" "$install_dir/runtime-pod.mjs"
# Mounted read-only into each NapCat container: an explicit QQ logout survives its restarts.
install -m 600 "$source_dir/../docker/start-napcat.sh" "$install_dir/start-napcat.sh"
install -m 600 "$source_dir/../packages/contracts/src/plugin-catalog.json" "$install_dir/plugin-catalog.json"
install -m 600 "$source_dir/../plugins/console/src/shared/context-policy.json" "$install_dir/context-policy.json"
# validateConfig rejects resource/path/origin mistakes before installing secrets or service.
"$node_bin" --input-type=module - "$config" "$owner_state" "$activate" <<'JS'
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validateConfig } from '/opt/yesimbot-account-manager/runtime-manager.mjs';
const c=validateConfig(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
c.contextPolicyFile ??= process.argv[3]+'/data/console-admin/context-policy.json';
function safe(p) { let part=''; for(const x of p.split('/').filter(Boolean)) { part+='/'+x; if(fs.existsSync(part)&&fs.lstatSync(part).isSymbolicLink()) throw Error('Unsafe path'); } }
for(const p of [c.rootDir,c.tokenFile,process.argv[3]]) safe(p);
fs.mkdirSync(c.rootDir,{recursive:true,mode:0o700}); fs.chmodSync(c.rootDir,0o700);
const keyDir=c.tokenFile.slice(0,c.tokenFile.lastIndexOf('/')); fs.mkdirSync(keyDir,{recursive:true,mode:0o700});
if(!fs.existsSync(c.tokenFile)) fs.writeFileSync(c.tokenFile,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});
const st=fs.statSync(c.tokenFile), key=fs.readFileSync(c.tokenFile,'utf8');
if(st.uid!==0 || st.mode&0o077 || !/^[a-f0-9]{64}\n?$/.test(key)) throw Error('Unsafe key file');
const target=process.argv[3]+'/data/console-admin'; safe(target); fs.mkdirSync(target,{recursive:true,mode:0o700});
const file=target+'/runtime-manager.key'; safe(file);
fs.writeFileSync(file,key,{mode:0o600}); fs.chmodSync(file,0o600);
// Private canonical config avoids systemd interpolation of operator paths.
fs.writeFileSync('/opt/yesimbot-account-manager/config.json',JSON.stringify(c)+'\n',{mode:0o600});
JS
# Node path is discovered locally; reject systemd token expansion/control characters.
[[ $node_bin =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Unsupported Node executable path.' >&2; exit 1; }
cat > /etc/systemd/system/yesimbot-account-manager.service <<UNIT
[Unit]
Description=YesImBot isolated account runtime manager
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=simple
User=root
UMask=0077
ExecStart=$node_bin /opt/yesimbot-account-manager/runtime-manager.mjs /opt/yesimbot-account-manager/config.json
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable yesimbot-account-manager.service
systemctl restart yesimbot-account-manager.service
# Authenticate without capability in command arguments, URL or output.
"$node_bin" --input-type=module - "$owner_state" "$activate" <<'JS'
import fs from 'node:fs'; import http from 'node:http';
const c=JSON.parse(fs.readFileSync('/opt/yesimbot-account-manager/config.json','utf8'));
const key=fs.readFileSync(c.tokenFile,'utf8').trim();
let healthy=false;
for(let n=0;n<30;n++) {
 healthy=await new Promise(resolve=>{const q=http.get({host:c.bindHost,port:c.port,path:'/health',headers:{authorization:'Bearer '+key}},r=>{r.resume();resolve(r.statusCode===200)});q.setTimeout(2000,()=>q.destroy());q.on('error',()=>resolve(false));});
 if(healthy)break; await new Promise(r=>setTimeout(r,500));
}
if(!healthy)throw Error('Manager health failed; parent configuration unchanged.');
const file=process.argv[3];
if(file) {
 const st=fs.lstatSync(file); if(!st.isFile()||st.isSymbolicLink())throw Error('Unsafe owner config.');
 const text=fs.readFileSync(file,'utf8'); let entry;
 try{entry=JSON.parse(text)}catch{throw Error('Owner console settings are not JSON.');}
 const settings=entry?.config; if(entry?.enabled===false||!settings?.admin?.enabled)throw Error('A managed owner console is required.');
 const backup=file+'.before-accounts'; if(!fs.existsSync(backup))fs.writeFileSync(backup,text,{flag:'wx',mode:0o600});
 settings.accounts={...settings.accounts,enabled:true,usersFile:'data/console-admin/accounts.json',managerEndpoint:'http://'+c.bindHost+':'+c.port,managerKeyFile:'data/console-admin/runtime-manager.key'};
 const temp=file+'.accounts.tmp';fs.writeFileSync(temp,JSON.stringify(entry,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);
}
JS
echo 'Host manager healthy. Private capability installed. Restart only the owner host after review; QQ was not restarted.'
