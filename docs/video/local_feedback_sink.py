# Stand-in for the Apps Script webhook while recording the demo: accepts the secret "test-secret" and
# writes rows to rows.jsonl, so the feedback form can be shown without touching the real sheet.
import json, http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b=json.loads(self.rfile.read(int(self.headers['content-length'])))
        ok = b.get('secret')=='test-secret'
        open('rows.jsonl','a').write(json.dumps(b['row'])+'\n')
        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'ok':ok} if ok else {'ok':False,'error':'forbidden'}).encode())
    def log_message(self,*a): pass
http.server.HTTPServer(('127.0.0.1',3999),H).serve_forever()
