import http.server, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
handler = http.server.SimpleHTTPRequestHandler
httpd = http.server.HTTPServer(('', 3333), handler)
print('Santaglia · http://localhost:3333', flush=True)
httpd.serve_forever()
