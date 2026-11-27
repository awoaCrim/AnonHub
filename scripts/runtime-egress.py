#!/usr/bin/env python3
"""Public HTTPS CONNECT gateway to loopback Mihomo SOCKS; never tunnels private IPs.

Bind/firewall restrict callers to bot bridges. Resolve and pin public addresses before
SOCKS dispatch so a member cannot use the shared proxy to bypass tenant isolation.
Mihomo's cn-ip / final rules select direct vs foreign egress for the pinned address.
"""
import asyncio
import ipaddress
import os
import socket
import struct


def public_address(value):
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global and not address.is_multicast


async def resolve_public(host):
    records = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    addresses = list(dict.fromkeys(row[4][0] for row in records))
    if not addresses or any(not public_address(ip) for ip in addresses):
        raise ValueError("destination_denied")
    # The configured relay is IPv4-capable. IPv6 remains usable when it is the only answer.
    return sorted(addresses, key=lambda ip: ':' in ip)[0]


async def socks_connect(address):
    reader, writer = await asyncio.open_connection('127.0.0.1', int(os.environ.get('SOCKS_PORT', '10819')))
    try:
        writer.write(b'\x05\x01\x00')
        await writer.drain()
        if await reader.readexactly(2) != b'\x05\x00':
            raise OSError('socks_auth_failed')
        ip = ipaddress.ip_address(address)
        writer.write(b'\x05\x01\x00' + (b'\x01' if ip.version == 4 else b'\x04') + ip.packed + struct.pack('!H', 443))
        await writer.drain()
        header = await reader.readexactly(4)
        if header[:2] != b'\x05\x00':
            raise OSError('socks_connect_failed')
        size = {1: 4, 4: 16}.get(header[3])
        if size is None:
            if header[3] != 3: raise OSError('invalid_socks_reply')
            size = (await reader.readexactly(1))[0]
        await reader.readexactly(size + 2)
        return reader, writer
    except BaseException:
        writer.close()
        raise


async def pump(reader, writer):
    while data := await asyncio.wait_for(reader.read(65536), 180):
        writer.write(data)
        await writer.drain()


async def handle(reader, writer):
    upstream = None
    tasks = []
    established = False
    try:
        request = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
        if len(request) > 8192: raise ValueError('header_too_large')
        method, authority, version = request.split(b'\r\n', 1)[0].decode('ascii').split(' ')
        host, sep, port = authority.rpartition(':')
        if method != 'CONNECT' or port != '443' or not sep or version != 'HTTP/1.1' or not host or any(c in host for c in '/@?#\\'):
            raise ValueError('destination_denied')
        address = await asyncio.wait_for(resolve_public(host.strip('[]')), 10)
        upstream_reader, upstream = await asyncio.wait_for(socks_connect(address), 20)
        writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        await writer.drain()
        established = True
        tasks = [asyncio.create_task(pump(reader, upstream)), asyncio.create_task(pump(upstream_reader, writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except Exception as error:
        if not established:
            status = b'403 Forbidden' if isinstance(error, ValueError) else b'502 Bad Gateway'
            writer.write(b'HTTP/1.1 ' + status + b'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            try: await writer.drain()
            except Exception: pass
    finally:
        for task in tasks: task.cancel()
        if tasks: await asyncio.gather(*tasks, return_exceptions=True)
        if upstream: upstream.close()
        writer.close()


async def main():
    server = await asyncio.start_server(handle, os.environ.get('BIND_HOST', '127.0.0.1'), int(os.environ.get('PORT', '18443')), limit=8192)
    async with server: await server.serve_forever()


if __name__ == '__main__':
    asyncio.run(main())
