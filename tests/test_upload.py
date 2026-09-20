import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from upload_library import LibraryClient


class CloudUploadTests(unittest.TestCase):
    def test_rejects_unsafe_destinations_before_sending_code(self):
        with patch.object(LibraryClient, 'request') as request:
            for site in ['http://example.com', 'https://user:pass@example.com',
                         'https://example.com/path', 'https://example.com?code=secret']:
                with self.assertRaises(ValueError):
                    LibraryClient(site, 'private code')
            request.assert_not_called()

    def test_resume_skips_existing_chapter_and_streams_only_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)/'测试书'; directory.mkdir()
            (directory/'001.m4a').write_bytes(b'first')
            (directory/'002.m4a').write_bytes(b'second')
            (directory/'.download-archive.txt').write_text('ignored')
            (directory/'003.m4a').symlink_to(directory/'001.m4a')
            existing = hashlib.sha256('测试书/001.m4a'.encode()).hexdigest()[:24]
            sent = []
            def request(client, method, path, body=None, headers=None):
                if path == '/api/login':
                    return 200, b'{}', {'set-cookie':'recap_session=test; Secure; HttpOnly'}
                if path == '/api/library':
                    return 200, json.dumps({'books':[{'chapters':[{'id':existing}]}]}).encode(), {}
                sent.append((body.read(), headers['Content-Length']))
                return 201, b'{}', {}
            with patch.object(LibraryClient, 'request', request):
                self.assertEqual(LibraryClient('https://example.com', 'code').sync(directory), (1,1))
            self.assertEqual(sent, [(b'second','6')])

    def test_failed_login_or_redirect_does_not_start_upload(self):
        for status in (301, 401, 429):
            with patch.object(LibraryClient, 'request', return_value=(status, b'', {})) as request:
                with self.assertRaises(ValueError):
                    LibraryClient('https://example.com', 'code')
                self.assertEqual(request.call_count, 1)


if __name__ == '__main__':
    unittest.main()
