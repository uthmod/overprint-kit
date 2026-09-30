# ponytail: throwaway localhost receiver so the Firefly tab can hand over its blob images.
# usage: python recv.py <out_dir>   (run in background, stop it when done)
import http.server, urllib.parse, os, sys
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
class H(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "https://firefly.adobe.com")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()
    def do_POST(self):
        name = os.path.basename(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)["name"][0])
        data = self.rfile.read(int(self.headers["Content-Length"]))
        open(os.path.join(OUT, name), "wb").write(data)
        self.send_response(200); self.cors(); self.end_headers(); self.wfile.write(str(len(data)).encode())
http.server.HTTPServer(("127.0.0.1", 8765), H).serve_forever()
