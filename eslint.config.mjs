import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["build/", "coverage/", "e2e/.*/", "src/locales/", "**/*.d.ts", "glass-*-server/"] },
    js.configs.recommended,
    tseslint.configs.recommended,
    react.configs.flat.recommended,
    react.configs.flat["jsx-runtime"],
    {
        // The previous ESLint did not report unused disable comments; there are 14 old ones (a cleanup for later).
        linterOptions: { reportUnusedDisableDirectives: "off" },
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
        plugins: { "react-hooks": reactHooks, "unused-imports": unusedImports, import: importPlugin },
        settings: {
            "import/resolver": { node: { extensions: [".js", ".jsx", ".ts", ".tsx"] } },
            react: { version: "detect" },
        },
        rules: {
            "no-console": ["warn", { allow: ["debug", "warn", "error"] }],
            "unused-imports/no-unused-imports": "warn",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
            ],
            "react/prop-types": "off",
            "react/display-name": "off",
            "react/jsx-key": "warn",
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
            "no-unused-expressions": "off",
            "@typescript-eslint/no-unused-expressions": "off",
            "no-useless-concat": "off",
            "no-useless-constructor": "off",
            "no-unexpected-multiline": "off",
            "default-case": "off",
            "no-use-before-define": "off",
            "no-debugger": "warn",
            // Kept from the old "react-app" preset, which the previous config extended.
            "no-loop-func": "warn",
            "no-new-func": "warn",
            "unicode-bom": ["warn", "never"],
            "@typescript-eslint/no-non-null-assertion": "warn",
            "no-extra-semi": "off",
            "no-mixed-spaces-and-tabs": "off",
            "array-callback-return": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-empty-interface": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-unsafe-function-type": "off",
            "@typescript-eslint/no-wrapper-object-types": "off",
            "@typescript-eslint/ban-ts-comment": "off",
            "@typescript-eslint/no-require-imports": "off",
            // Clean architecture: the domain layer must not import the data layer, the webapp, the scripts or the
            // composition root. An error, so a new leak fails lint; the two known exceptions are listed below.
            "import/no-restricted-paths": [
                "error",
                {
                    zones: [
                        { target: "./src/domain", from: "./src/data" },
                        { target: "./src/domain", from: "./src/webapp" },
                        { target: "./src/domain", from: "./src/scripts" },
                        { target: "./src/domain", from: "./src/CompositionRoot.ts" },
                    ],
                },
            ],
        },
    },
    {
        files: ["src/domain/**/*.{ts,tsx}"],
        rules: {
            // The domain layer must not depend on DHIS2 libraries or on the d2-api wrapper.
            "no-restricted-imports": [
                "error",
                { patterns: ["@eyeseetea/d2-api", "@eyeseetea/d2-api/*", "@dhis2/*", "d2", "**/types/d2-api"] },
            ],
        },
    },
    {
        // Known exceptions, still reported as warnings until they are redesigned: the program-rule types come
        // from d2-api, and the template download uses the data layer's spreadsheet builder.
        files: ["src/domain/entities/program-rules/EventEffectTypes.ts", "src/domain/utils/DownloadTemplate.ts"],
        rules: {
            "import/no-restricted-paths": "warn",
            "no-restricted-imports": "warn",
        },
    }
);
