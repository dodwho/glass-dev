/* Fails the build when a secret has ended up in the browser bundle. Create React App copies every
   REACT_APP_* variable (and, where code reads process.env as a whole, the whole set) into the built files,
   so anything found here would be readable by every user of the app.

   Only the file and the variable name are printed, never the value. */
const fs = require("fs");
const path = require("path");

const buildDir = path.join(__dirname, "..", "build");
const patterns = [
    { description: "a DHIS2 personal access token", regex: /d2p(?:at)?_[A-Za-z0-9]{20,}/ },
    {
        description: "a secret variable with a value",
        regex: /\b((?:REACT_APP_|DHIS2_)[A-Z0-9_]*(?:TOKEN|AUTH|PASSWORD|SECRET)[A-Z0-9_]*)["']?\s*:\s*(["'])(?!\2)/,
    },
    {
        description: "a URL with a username or password in it",
        regex: /\b(REACT_APP_[A-Z0-9_]*)["']?\s*:\s*["']https?:\/\/[^"'/@\s]+@/,
    },
];

function* listFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* listFiles(fullPath);
        else if (/\.(js|html|json)$/.test(entry.name)) yield fullPath;
    }
}

const findings = [];
for (const file of listFiles(buildDir)) {
    const content = fs.readFileSync(file, "utf8");
    for (const { description, regex } of patterns) {
        const match = content.match(regex);
        if (match) findings.push(`${path.relative(buildDir, file)}: ${description}${match[1] ? ` (${match[1]})` : ""}`);
    }
}

if (findings.length > 0) {
    console.error("Build stopped: secrets found in the browser bundle:\n  " + findings.join("\n  "));
    console.error(
        "Secret variables must not start with REACT_APP_. Rename them (e.g. DHIS2_TOKEN_PROD) in the .env files."
    );
    process.exit(1);
}
console.log("No secrets found in the build.");
