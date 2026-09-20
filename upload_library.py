#!/usr/bin/env python3
"""Upload completed local chapters to your private HTTPS library; reruns skip existing IDs."""
import argparse
import hashlib
import http.client
from http.cookies import SimpleCookie
import json
from pathlib import Path
import ssl
import sys
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parent
MAX_FILE = 80 * 1024 * 1024

class LibraryClient:
    def __init__(self, site, code):
        url = urlsplit(site)
        if (url.scheme != 'https' or not url.hostname or url.username or url.password
                or url.path not in ('', '/') or url.query or url.fragment):
            raise ValueError('Use the HTTPS origin of your own library, without a path or credentials.')
        self.host, self.port = url.hostname, url.port or 443
        self.cookie = None
        status, body, headers = self.request('POST', '/api/login', json.dumps({'code': code}).encode(),
                                             {'Content-Type': 'application/json'})
        if status != 200:
            raise ValueError(f'Cloud login failed (HTTP {status}). Check the site and access-code file.')
        cookies = SimpleCookie(); cookies.load(headers.get('set-cookie', ''))
        if 'recap_session' not in cookies:
            raise ValueError('Cloud login did not return a session.')
        self.cookie = 'recap_session=' + cookies['recap_session'].value

    def request(self, method, path, body=None, headers=None):
        # No redirects: credentials and audio are sent only to the explicitly selected origin.
        connection = http.client.HTTPSConnection(self.host, self.port, timeout=300,
                                                 context=ssl.create_default_context())
        request_headers = {'X-Recap-Request': '1', **(headers or {})}
        if self.cookie:
            request_headers['Cookie'] = self.cookie
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, response.read(65536), {k.lower(): v for k, v in response.getheaders()}
        finally:
            connection.close()

    def sync(self, directory):
        status, body, _ = self.request('GET', '/api/library')
        if status != 200:
            raise ValueError(f'Cannot read cloud library (HTTP {status}).')
        existing = {c['id'] for b in json.loads(body)['books'] for c in b['chapters']}
        uploaded = skipped = 0
        for file in sorted(directory.iterdir()):
            if file.suffix.lower() not in {'.m4a', '.mp3'} or not file.is_file() or file.is_symlink():
                continue
            chapter_id = hashlib.sha256(f'{directory.name}/{file.name}'.encode()).hexdigest()[:24]
            if chapter_id in existing:
                skipped += 1
                continue
            size = file.stat().st_size
            if size <= 0 or size > MAX_FILE:
                raise ValueError(f'{file.name}: online uploads must be between 1 byte and 80 MB.')
            print(f'Uploading: {file.name}', flush=True)
            with file.open('rb') as audio:
                status, body, _ = self.request('POST', '/api/upload', audio, {
                    'Content-Length': str(size), 'Content-Type': 'application/octet-stream',
                    'X-Book-Name': quote(directory.name, safe=''), 'X-File-Name': quote(file.name, safe='')})
            if status == 201:
                uploaded += 1
            elif status == 409:
                skipped += 1
            else:
                raise ValueError(f'Upload stopped (HTTP {status}). Completed chapters are preserved; rerun to resume.')
        print(f'Cloud sync complete: {uploaded} uploaded, {skipped} already present.')
        return uploaded, skipped

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', required=True, help='Your own deployed HTTPS library origin')
    parser.add_argument('--book', required=True)
    parser.add_argument('--code-file', type=Path, default=ROOT/'data/access-code.txt')
    args = parser.parse_args()
    directory = ROOT/'library'/args.book
    if not args.book or args.book.startswith('.') or any(c in args.book for c in '/\\') or not directory.is_dir() or directory.is_symlink():
        parser.error('Choose an existing book directory inside library/.')
    try:
        LibraryClient(args.site, args.code_file.read_text().strip()).sync(directory)
    except (OSError, ValueError, http.client.HTTPException) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
