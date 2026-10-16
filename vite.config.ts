/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, Plugin } from "vite";
import checker from "vite-plugin-checker";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { createDhis2Proxy } from "./config/dhis2-proxy";

export default defineConfig(({ mode }) => {
    // .env, .env.local, ...: shell variables win, as with dotenv. Only VITE_* variables can reach the browser
    // bundle (none are used), so the DHIS2 credentials read by the proxy below never do.
    for (const [name, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) process.env[name] ??= value;

    return {
        // DHIS2 serves the app from /api/apps/glass/, so every asset path must be relative.
        base: "",
        // Unit tests run in Node with its real modules: the browser polyfills and the dev tools are not for them.
        // No browser copy of Node's crypto: only unused library paths import it (password-encrypted workbooks in
        // xlsx-populate, libsodium's Node branch, elliptic's random source), and it carried known vulnerabilities.
        plugins:
            mode === "test"
                ? [react()]
                : [
                      react(),
                      nodePolyfills({ exclude: ["crypto"] }),
                      checker({ typescript: true }),
                      dhis2Proxy(),
                      devOnlyHtml(),
                  ],
        resolve: {
            // PapaParse's browser entry is its pre-minified file. Vite's minifier renames the variables in it in a
            // way that breaks the Web Worker PapaParse builds from its own source: every parsed CSV row comes back
            // empty. The readable file of the same version is minified correctly.
            alias: [{ find: /^papaparse$/, replacement: "papaparse/papaparse.js" }],
        },
        build: { outDir: "build" },
        server: { port: Number(process.env.PORT) || 3000 },
        test: {
            environment: "jsdom",
            include: ["src/**/*.{spec,test}.{ts,tsx}"],
            globals: true,
            // `yarn test:coverage`: report in coverage/ (git-ignored).
            coverage: {
                provider: "v8",
                include: ["src/**/*.{ts,tsx}"],
                exclude: ["src/**/__tests__/**", "src/**/*.{spec,test}.{ts,tsx}", "src/locales/**", "src/**/*.d.ts"],
                reporter: ["text-summary", "json-summary", "json", "html"],
            },
        },
    };
});

/** Proxies /dhis2 to the instance in .env.local, as `yarn start` always did (see config/dhis2-proxy.js). */
function dhis2Proxy(): Plugin {
    return {
        name: "glass-dhis2-proxy",
        configureServer: server => void server.middlewares.use(createDhis2Proxy()),
    };
}

/** Drops the development-only block of index.html (the feedback tool) from production builds. */
function devOnlyHtml(): Plugin {
    return {
        name: "glass-dev-only-html",
        apply: "build",
        transformIndexHtml: {
            order: "pre",
            handler: html => html.replace(/<!-- dev-only -->[\s\S]*?<!-- \/dev-only -->/g, ""),
        },
    };
}
