import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = 4175;
const root = join(import.meta.dirname, "dist");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const bootstrap = {
  mode: "local",
  tasks: [],
  automations: [],
  projects: [],
  repository: {
    name: "elijahbowie/grok-build",
    branch: "main",
  },
  settings: {
    model: "grok-4.5",
    permissionMode: "isolated-write",
  },
  capabilities: {
    models: ["grok-4.5"],
    remoteRunner: false,
  },
};

createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (url.pathname === "/api/bootstrap") {
    response.writeHead(200, { "content-type": contentTypes[".json"] });
    response.end(JSON.stringify(bootstrap));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    response.writeHead(404, { "content-type": contentTypes[".json"] });
    response.end(JSON.stringify({ error: "Preview endpoint unavailable" }));
    return;
  }

  const relativePath = normalize(url.pathname)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const requestedPath = join(root, relativePath || "index.html");

  try {
    const body = await readFile(requestedPath);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes[extname(requestedPath)] || "application/octet-stream",
    });
    response.end(body);
  } catch {
    const body = await readFile(join(root, "index.html"));
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypes[".html"],
    });
    response.end(body);
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Grok Build preview running at http://localhost:${port}`);
});
