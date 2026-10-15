/* Environment for the browser tests: the DHIS2 instance comes from .env.local, as for `yarn start`.
   Writes to DHIS2 are only ever allowed against DEV. */
const path = require("path");
const dotenv = require("dotenv");

const root = path.join(__dirname, "..");
// dotenv never overwrites a variable that is already set, so .env.local wins over the tracked .env.
dotenv.config({ path: path.join(root, ".env.local") });
dotenv.config({ path: path.join(root, ".env") });

const DEV_INSTANCE = "extranet.who.int/dhis2-dev";

function getInstance() {
    const url = process.env.REACT_APP_DHIS2_BASE_URL;
    if (!url) throw new Error("Set REACT_APP_DHIS2_BASE_URL in .env.local");
    const { host, pathname } = new URL(url);
    return { url: url.replace(/\/$/, ""), name: host + pathname.replace(/\/$/, "") };
}

/** True when E2E_ALLOW_WRITES=1. Throws if writes are requested for any instance other than DEV. */
function writesAllowed() {
    if (process.env.E2E_ALLOW_WRITES !== "1") return false;
    const { name } = getInstance();
    if (name !== DEV_INSTANCE) throw new Error(`Browser tests may only write to ${DEV_INSTANCE}, not ${name}`);
    return true;
}

module.exports = { root, getInstance, writesAllowed };
