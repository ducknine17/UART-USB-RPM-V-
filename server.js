"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT || 5173);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pdf", "application/pdf"],
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    const route = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.resolve(root, `.${route}`);

    if (!filePath.startsWith(root)) {
      send(response, 403, "Forbidden", "text/plain; charset=utf-8");
      return;
    }

    const file = await fs.readFile(filePath);
    const type = mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
    });
    response.end(file);
  } catch (error) {
    send(response, 404, "Not found", "text/plain; charset=utf-8");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Fardriver UART Monitor: http://localhost:${port}`);
});

function send(response, status, body, type) {
  response.writeHead(status, { "content-type": type });
  response.end(body);
}
