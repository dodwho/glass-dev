const { createProxyMiddleware } = require("http-proxy-middleware");

/* react-script automatically executes src/setupProxy.js on init. Tasks:

    - Proxy requests from /dhis2/xyz to $REACT_APP_DHIS2_BASE_URL/xyz. Reason: Avoid problems with
      CORS and cross-domain cookies, as the app connects only to the local development server.

    - Redirect paths in `redirectPaths` to the original DHIS2 URL. Reason: some apps, i.e. Pivot Table App,
      do not work through the proxy. Tipically, these links are rendered on iframed dashboards.
*/

const redirectPaths = ["/dhis-web-pivot", "/dhis-web-data-visualizer"];

const dhis2UrlVar = "REACT_APP_DHIS2_BASE_URL";
const dhis2AuthVar = "DHIS2_AUTH";
const dhis2TokenVar = "DHIS2_TOKEN";
const proxyLogLevel = "REACT_APP_PROXY_LOG_LEVEL";

// Secrets must not start with REACT_APP_: Create React App copies every REACT_APP_* variable into the built app.
// The old names are still read, with a warning, so an existing .env keeps working until it is renamed.
function getSecret(name) {
    const legacyName = `REACT_APP_${name}`;
    if (!process.env[name] && process.env[legacyName]) {
        console.warn(`${legacyName} is deprecated: rename it to ${name} in the .env file.`);
    }
    return process.env[name] || process.env[legacyName];
}

module.exports = function (app) {
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

    const proxyOptions = {
        target: targetUrl,
        logLevel,
        changeOrigin: true,
        pathRewrite: { "^/dhis2/": "/" },
        onProxyReq: function (proxyReq, req, res) {
            const { path } = proxyReq;
            const shouldRedirect = redirectPaths.some(redirectPath => path.startsWith(redirectPath));

            if (shouldRedirect) {
                const redirectUrl = targetUrl.replace(/\/$/, "") + path;
                res.location(redirectUrl);
                res.sendStatus(302);
            }
        },
    };

    if (token) {
        proxyOptions.headers = { Authorization: `ApiToken ${token}` };
    } else if (auth) {
        proxyOptions.auth = auth;
    }

    const proxy = createProxyMiddleware(proxyOptions);
    app.use(["/dhis2"], proxy);
};
