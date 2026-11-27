import asyncio
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('egress', pathlib.Path(__file__).parents[1] / 'runtime-egress.py')
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)

class EgressTests(unittest.IsolatedAsyncioTestCase):
    def test_private_and_mapped_addresses(self):
        for ip in ['127.0.0.1', '10.1.2.3', '172.19.0.3', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1', '224.0.0.1']:
            self.assertFalse(egress.public_address(ip), ip)
        self.assertTrue(egress.public_address('8.8.8.8'))

    async def test_rejects_private_connect_and_non_connect(self):
        async with await asyncio.start_server(egress.handle, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            for request in [b'CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n', b'CONNECT example.com:22 HTTP/1.1\r\n\r\n', b'GET http://example.com HTTP/1.1\r\n\r\n']:
                reader, writer = await asyncio.open_connection('127.0.0.1', port)
                writer.write(request)
                await writer.drain()
                self.assertIn(b'403 Forbidden', await reader.read())
                writer.close()
                await writer.wait_closed()

    async def test_mixed_dns_answer_is_rejected(self):
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'getaddrinfo', return_value=[(0, 0, 0, '', ('8.8.8.8', 443)), (0, 0, 0, '', ('127.0.0.1', 443))]):
            with self.assertRaises(ValueError): await egress.resolve_public('example.com')
