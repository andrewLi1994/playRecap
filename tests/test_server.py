import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import LibraryServer

class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.server = LibraryServer(('127.0.0.1', 0), root/'data', root/'library')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.port = self.server.server_port
        self.cookie = ''
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.tmp.cleanup()
    def request(self, method, path, body=None, headers=None, auth=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        merged = {'X-Recap-Request': '1'}
        if auth: merged['Cookie'] = self.cookie
        merged.update(headers or {})
        connection.request(method, path, body, merged)
        r = connection.getresponse(); result = r.status, dict(r.getheaders()), r.read(); connection.close(); return result
    def login(self):
        status, headers, _ = self.request('POST','/api/login',json.dumps({'code':self.server.code}))
        self.assertEqual(status, 200); self.cookie = headers['Set-Cookie'].split(';')[0]
    def upload(self, name='02.mp3', content=b'abcdefghij', book='Book'):
        return self.request('POST','/api/upload',content,{'X-Book-Name':book,'X-File-Name':name})
    def test_auth_and_private_paths(self):
        self.assertEqual(self.request('GET','/api/library',auth=False)[0],401)
        self.assertEqual(self.request('POST','/api/login','{"code":"wrong"}')[0],401)
        self.login()
        for p in ['/data/access-code.txt','/server.py','/../data/access-code.txt','/library/Book/02.mp3','/.git/config']:
            self.assertEqual(self.request('GET',p)[0],404)
        self.assertEqual(self.request('POST','/api/logout','{}')[0],200)
        # Removing the cookie gates the library (signed sessions expire independently).
        self.cookie = ''; self.assertEqual(self.request('GET','/api/library')[0],401)
    def test_upload_sort_conflict_traversal(self):
        self.login()
        self.assertEqual(self.upload()[0],201)
        self.assertEqual(self.upload('10.mp3')[0],201)
        self.assertEqual(self.upload('1.mp3')[0],201)
        self.assertEqual(self.upload()[0],409)
        for name in ['../escape.mp3','%2e%2e%2fescape.mp3','.secret.mp3','bad.txt']:
            self.assertEqual(self.upload(name)[0],400)
        data=json.loads(self.request('GET','/api/library')[2]); self.assertEqual([c['title'] for c in data['books'][0]['chapters']],['1','02','10'])
    def test_ranges_and_head(self):
        self.login(); self.upload()
        url=json.loads(self.request('GET','/api/library')[2])['books'][0]['chapters'][0]['url']
        self.assertEqual(self.request('GET',url,auth=False)[0],401)
        for header, expected in [('bytes=0-1',b'ab'),('bytes=5-',b'fghij'),('bytes=-3',b'hij'),('bytes=7-99',b'hij')]:
            status,headers,body=self.request('GET',url,headers={'Range':header})
            self.assertEqual(status,206); self.assertEqual(body,expected); self.assertEqual(headers['Accept-Ranges'],'bytes')
        for header in ['bytes=90-','bytes=5-2','bytes=-0','bytes=0-1,4-5','bytes=-']:
            self.assertEqual(self.request('GET',url,headers={'Range':header})[0],416)
        status,headers,body=self.request('HEAD',url); self.assertEqual(status,200); self.assertEqual(headers['Content-Length'],'10'); self.assertEqual(body,b'')
    def test_csrf_and_symlink(self):
        self.login()
        self.assertEqual(self.request('POST','/api/upload',b'abc',{'X-Recap-Request':'','X-Book-Name':'Book','X-File-Name':'01.mp3'})[0],403)
        outside=Path(self.tmp.name)/'outside';outside.mkdir(); (outside/'secret.mp3').write_bytes(b'secret')
        (self.server.library/'Link').symlink_to(outside)
        self.assertEqual(self.upload(book='Link')[0],400)
        self.assertEqual(json.loads(self.request('GET','/api/library')[2])['books'],[])

if __name__ == '__main__': unittest.main()
