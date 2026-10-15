const { createProxyMiddleware } = require("http-proxy-middleware");

/* Middleware for the local servers (development server and browser-test server). Tasks:

    - Proxy requests from /dhis2/xyz to $REACT_APP_DHIS2_BASE_URL/xyz. Reason: Avoid problems with
      CORS and cross-domain cookies, as the app connects only to the local server.

    - Redirect paths in `redirectPaths` to the original DHIS2 URL. Reason: some apps, i.e. Pivot Table App,
      do not work through the proxy. Tipically, these links are rendered on iframed dashboards.

   Plain Node (req, res, next) middleware, so it works with Express, Connect (Vite) and http.createServer.
*/

const redirectPaths = ["/dhis-web-pivot", "/dhis-web-data-visualizer"];

const dhis2UrlVar = "REACT_APP_DHIS2_BASE_URL";
const dhis2AuthVar = "DHIS2_AUTH";
const dhis2TokenVar = "DHIS2_TOKEN";
const proxyLogLevel = "REACT_APP_PROXY_LOG_LEVEL";

// Secrets must not start with REACT_APP_: the build copies every REACT_APP_* variable into the built app.
// The old names are still read, with a warning, so an existing .env keeps working until it is renamed.
function getSecret(name) {
    const legacyName = `REACT_APP_${name}`;
    if (!process.env[name] && process.env[legacyName]) {
        console.warn(`${legacyName} is deprecated: rename it to ${name} in the .env file.`);
    }
    return process.env[name] || process.env[legacyName];
}

function createDhis2Proxy() {
    const targetUrl = process.env[dhis2UrlVar];
    const auth = getSecret(dhis2AuthVar);
    const token = getSecret(dhis2TokenVar);
    const logLevel = process.env[proxyLogLevel] || "warn";

    if (!targetUrl) {
        console.error(`Set ${dhis2UrlVar} to base DHIS2 URL`);
        process.exit(1);
    }

    if (!token && !auth) {
        console.warn(`No auth configured. Set ${dhis2TokenVar} (preferred, works with 2FA) or ${dhis2AuthVar}.`);
    }

    const proxy = createProxyMiddleware({
        target: targetUrl,
        logLevel,
        changeOrigin: true,
        pathRewrite: { "^/dhis2/": "/" },
        ...(token ? { headers: { Authorization: `ApiToken ${token}` } } : auth ? { auth } : {}),
    });

    return (req, res, next) => {
        if (!req.url.startsWith("/dhis2/")) return next();

        const path = req.url.slice("/dhis2".length);
        if (redirectPaths.some(redirectPath => path.startsWith(redirectPath))) {
            res.writeHead(302, { Location: targetUrl.replace(/\/$/, "") + path });
            res.end();
            return;
        }
        // When DHIS2 drops a connection mid-response, the proxy has already answered with an error and the rest
        // of DHIS2's response fails to write. Log it instead of letting the unhandled error stop the server.
        res.on("error", error => console.warn(`Proxy response error for ${req.url}: ${error.message}`));
        return proxy(req, res, next);
    };
}

module.exports = { createDhis2Proxy };
