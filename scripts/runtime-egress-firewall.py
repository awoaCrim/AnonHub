#!/usr/bin/env python3
"""Install the public-egress port guard before the proxy starts, including after reboot."""
import json
import subprocess

PORT = '18443'
CHAIN = 'YESIMBOT-EGRESS'

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()

def main():
    listed = run('docker', 'network', 'ls', '--format', '{{.Name}}').splitlines()
    names = [n for n in listed if n == 'yesimbot-preview_default' or n.startswith('yesimbot-member-')]
    rules = [['-i', 'lo', '-j', 'ACCEPT']]
    for name in names:
        network = json.loads(run('docker', 'network', 'inspect', name))[0]
        bridge = network['Options'].get('com.docker.network.bridge.name') or 'br-' + network['Id'][:12]
        if name.startswith('yesimbot-member-'):
            member = name.removeprefix('yesimbot-member-')
            if network.get('Labels', {}).get('io.yesimbot.runtime') != member or not bridge.startswith('yb'):
                raise RuntimeError('foreign network')
        for config in network['IPAM']['Config']:
            if ':' not in config['Subnet']:
                rules.append(['-i', bridge, '-s', config['Subnet'], '-d', config['Gateway'], '-j', 'ACCEPT'])
    subprocess.run(['iptables', '-w', '-N', CHAIN], capture_output=True)
    # Reject first while refreshing the chain; an interrupted refresh must never open the proxy.
    subprocess.run(['iptables', '-w', '-I', CHAIN, '1', '-j', 'REJECT'], check=True)
    for rule in rules:
        subprocess.run(['iptables', '-w', '-I', CHAIN, '1', *rule], check=True)
    hook = ['-p', 'tcp', '--dport', PORT, '-j', CHAIN]
    if subprocess.run(['iptables', '-w', '-C', 'INPUT', *hook], capture_output=True).returncode:
        subprocess.run(['iptables', '-w', '-I', 'INPUT', '1', *hook], check=True)

if __name__ == '__main__': main()
