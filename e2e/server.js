/* Serves a built GLASS app for the browser tests, as DHIS2 would, and proxies /dhis2 to the instance in
   .env.local with the development server's proxy. Requests that would change DHIS2 are refused (403) unless
   E2E_ALLOW_WRITES=1, which env.js only accepts for DEV.
   Usage: node e2e/server.js <buildDir> <port> */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { getInstance, writesAllowed } = require("./env");
const { createDhis2Proxy } = require("../config/dhis2-proxy");

const [buildDir, port] = process.argv.slice(2);
const root = path.resolve(buildDir);
const allowWrites = writesAllowed();
const proxy = createDhis2Proxy();
const readOnlyMethods = ["GET", "HEAD", "OPTIONS"];
const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webapp": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
};

function serveStatic(req, res) {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (urlPath === "/manifest.webapp") {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webapp"), "utf8"));
        manifest.activities.dhis.href = `http://localhost:${port}/dhis2`;
        res.writeHead(200, { "Content-Type": contentTypes[".webapp"] });
        return res.end(JSON.stringify(manifest));
    }
    const file = path.join(root, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end();
    }
    res.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
    if (req.url.startsWith("/dhis2/") && !allowWrites && !readOnlyMethods.includes(req.method)) {
        res.writeHead(403, { "Content-Type": "application/json", "x-e2e-blocked": "1" });
        return res.end(JSON.stringify({ status: "ERROR", message: "Blocked by the read-only browser-test server" }));
    }
    proxy(req, res, () => serveStatic(req, res));
}).listen(Number(port), () => {
    const mode = allowWrites ? "WRITES ALLOWED" : "read-only";
    // eslint-disable-next-line no-console -- the server's start-up line, shown by Playwright
    console.log(`Serving ${root} on http://localhost:${port} -> ${getInstance().name} (${mode})`);
});
