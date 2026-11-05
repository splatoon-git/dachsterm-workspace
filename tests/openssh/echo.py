import socketserver


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while data := self.request.recv(65536):
            self.request.sendall(data)


with socketserver.ThreadingTCPServer(("127.0.0.1", 9000), Echo) as server:
    server.serve_forever()
