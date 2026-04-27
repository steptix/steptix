import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = 5173;
const root = path.dirname(fileURLToPath(import.meta.url));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".jsx": "text/babel; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = decodeURIComponent(requestUrl.pathname.slice(1)) || "index.html";
  const fullPath = path.resolve(root, requestedPath);

  if (!fullPath.startsWith(root) || !existsSync(fullPath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const extension = path.extname(fullPath).toLowerCase();
  const contentType = contentTypes[extension] || "application/octet-stream";
  const body = await readFile(fullPath);

  response.writeHead(200, { "content-type": contentType });
  response.end(body);
});

server.listen(port, () => {
  console.log(`TestBench Runner serving at http://localhost:${port}/`);
});
