#!/usr/bin/env python3
"""Private, dependency-free audio library. Put TLS in front before internet use."""
import argparse
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parent
EXTENSIONS = {'.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.mp4'}
MIME = {'.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac'}
STATIC = {'/': 'index.html', '/index.html': 'index.html', '/script.js': 'script.js', '/styles.css': 'styles.css', '/icon.svg': 'icon.svg', '/manifest.webmanifest': 'manifest.webmanifest', '/apple-touch-icon.png': 'apple-touch-icon.png', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png'}
MAX_UPLOAD = 2 * 1024 ** 3

def natural(value):
    return [int(x) if x.isdigit() else x.casefold() for x in re.split(r'(\d+)', value)]

def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)

class LibraryServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, data, library, secure=False):
        self.data, self.library, self.secure = Path(data), Path(library), secure
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.library.mkdir(parents=True, exist_ok=True)
        keyfile = self.data / 'access-code.txt'
        if not keyfile.exists():
            fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f: f.write(secrets.token_urlsafe(18))
        self.code = keyfile.read_text().strip()
        self.lock = threading.RLock()
        self.attempts = {}
        self.media = {}
        super().__init__(address, Handler)

    def catalog(self):
        books, media = [], {}
        with self.lock:
            for directory in sorted(self.library.iterdir(), key=lambda p: natural(p.name)):
                if not directory.is_dir() or directory.is_symlink() or directory.name.startswith('.'): continue
                bid = hashlib.sha256(directory.name.encode()).hexdigest()[:24]
                chapters = []
                for path in sorted(directory.iterdir(), key=lambda p: natural(p.name)):
                    if path.is_symlink() or not path.is_file() or path.suffix.lower() not in EXTENSIONS: continue
                    cid = hashlib.sha256(str(path.relative_to(self.library)).encode()).hexdigest()[:24]
                    media[cid] = path
                    title = re.sub(r'^\d{5} - ', '', path.stem)
                    title = re.sub(r' \[[A-Za-z0-9_-]{11}\]$', '', title)
                    chapters.append({'id': cid, 'title': title, 'url': '/media/' + cid, 'bytes': path.stat().st_size})
                if chapters: books.append({'id': bid, 'title': directory.name, 'chapters': chapters})
            self.media = media
        return {'books': books}

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass  # No listening history, URLs, or credentials in logs.
    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        super().end_headers()
    def reply(self, status, value, headers=None):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD': self.wfile.write(payload)
    def authenticated(self):
        try:
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            raw = cookie['recap_session'].value
            expiry, signature = raw.split('.')
            expected = hmac.new(self.server.code.encode(), expiry.encode(), hashlib.sha256).hexdigest()
            return int(expiry) > time.time() and hmac.compare_digest(signature, expected)
        except (KeyError, ValueError): return False
    def do_HEAD(self): self.do_GET()
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in STATIC:
            return self.file(ROOT / STATIC[path], ranges=False)
        if path == '/api/session': return self.reply(200, {'authenticated': self.authenticated()})
        if not self.authenticated(): return self.reply(401, {'error': '请先输入私人访问口令。'})
        if path == '/api/library': return self.reply(200, self.server.catalog())
        if path.startswith('/media/'):
            self.server.catalog()
            media = self.server.media.get(path.removeprefix('/media/'))
            if media and media.exists(): return self.file(media, ranges=True)
        return self.reply(404, {'error': '文件不存在。'})
    def body(self, limit=8192):
        try: size = int(self.headers.get('Content-Length', '-1'))
        except ValueError: size = -1
        if not 0 <= size <= limit: raise ValueError('文件大小超出限制。')
        self.connection.settimeout(120)
        raw = self.rfile.read(size)
        if len(raw) != size: raise ValueError('上传中断，请重试。')
        return raw
    def do_POST(self):
        # Only our same-origin UI can send mutations. Reject ordinary cross-site forms.
        if self.headers.get('X-Recap-Request') != '1':
            self.close_connection = True
            return self.reply(403, {'error': '请求来源无效。'})
        path = urlsplit(self.path).path
        try:
            if path == '/api/login':
                now = time.time()
                ip = self.client_address[0]
                with self.server.lock:
                    recent = [t for t in self.server.attempts.get(ip, []) if now-t < 60]
                    if len(recent) >= 10:
                        self.close_connection = True
                        return self.reply(429, {'error': '尝试太频繁，请一分钟后重试。'})
                    recent.append(now)
                    self.server.attempts[ip] = recent
                data = json.loads(self.body())
                supplied = data.get('code', '')
                if not isinstance(supplied, str) or not hmac.compare_digest(supplied.encode(), self.server.code.encode()):
                    return self.reply(401, {'error': '口令不正确。'})
                expiry = str(int(now + 30 * 86400))
                signature = hmac.new(self.server.code.encode(), expiry.encode(), hashlib.sha256).hexdigest()
                cookie = f'recap_session={expiry}.{signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'
                if self.server.secure: cookie += '; Secure'
                return self.reply(200, {'ok': True}, {'Set-Cookie': cookie})
            if not self.authenticated():
                self.close_connection = True
                return self.reply(401, {'error': '请重新登录。'})
            if path == '/api/logout':
                self.body()
                return self.reply(200, {'ok': True}, {'Set-Cookie': 'recap_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})
            if path == '/api/upload': return self.upload()
            self.close_connection = True
            return self.reply(404, {'error': '接口不存在。'})
        except (ValueError, json.JSONDecodeError, OSError, TimeoutError) as exc:
            self.close_connection = True
            self.reply(400, {'error': str(exc) if isinstance(exc, ValueError) else '无法保存文件，请检查剩余空间后重试。'})
    def upload(self):
        book = unquote(self.headers.get('X-Book-Name', '')).strip()
        filename = unquote(self.headers.get('X-File-Name', '')).strip()
        for name in (book, filename):
            if not name or name.startswith('.') or len(name.encode()) > 220 or any(c in name for c in '/\\') or any(ord(c) < 32 for c in name):
                raise ValueError('书名或文件名无效。')
        if Path(filename).suffix.lower() not in EXTENSIONS: raise ValueError('请选择 MP3、M4A 或其他音频文件。')
        size = int(self.headers.get('Content-Length', '-1'))
        if not 0 < size <= MAX_UPLOAD: raise ValueError('单个文件需小于 2 GB，且不能为空。')
        directory = self.server.library / book
        if directory.is_symlink(): raise ValueError('书籍目录无效。')
        directory.mkdir(exist_ok=True)
        target = directory / filename
        temporary = directory / ('.upload-' + secrets.token_hex(12))
        self.connection.settimeout(120)
        try:
            remaining = size
            with temporary.open('xb') as f:
                while remaining:
                    chunk = self.rfile.read(min(1024*1024, remaining))
                    if not chunk: raise ValueError('上传中断，请重试。')
                    f.write(chunk)
                    remaining -= len(chunk)
            # Hard link is atomic and never overwrites an existing chapter.
            try: os.link(temporary, target)
            except FileExistsError: return self.reply(409, {'error': '同名章节已存在，未覆盖原文件。'})
        finally:
            temporary.unlink(missing_ok=True)
        return self.reply(201, {'ok': True})
    def file(self, path, ranges=False):
        size = path.stat().st_size
        start, end, status = 0, size-1, 200
        if ranges and self.headers.get('Range'):
            m = re.fullmatch(r'bytes=(\d*)-(\d*)', self.headers['Range'])
            if not m or not any(m.groups()): return self.reply(416, {}, {'Content-Range': f'bytes */{size}'})
            left, right = m.groups()
            if not left:
                count = int(right)
                if count <= 0: return self.reply(416, {}, {'Content-Range': f'bytes */{size}'})
                start = max(0, size-count)
            else:
                start = int(left)
                if right: end = min(int(right), size-1)
            if start >= size or end < start: return self.reply(416, {}, {'Content-Range': f'bytes */{size}'})
            status = 206
        self.send_response(status)
        self.send_header('Content-Type', MIME.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(max(0, end-start+1)))
        self.send_header('Cache-Control', 'private, no-store' if ranges else 'no-cache')
        if ranges:
            self.send_header('Accept-Ranges', 'bytes')
            if status == 206: self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        if self.command == 'HEAD': return
        try:
            with path.open('rb') as f:
                f.seek(start)
                remaining = end-start+1
                while remaining > 0:
                    chunk = f.read(min(256*1024, remaining))
                    if not chunk: break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError): pass

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8765')))
    parser.add_argument('--data', type=Path, default=ROOT / 'data')
    parser.add_argument('--library', type=Path, default=ROOT / 'library')
    parser.add_argument('--secure-cookie', action='store_true', help='Enable behind an HTTPS reverse proxy')
    args = parser.parse_args()
    server = LibraryServer((args.host, args.port), args.data, args.library, args.secure_cookie)
    print(f'playRecap: http://{args.host}:{args.port}', flush=True)
    print(f'Access code file: {args.data / "access-code.txt"}', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: server.server_close()
