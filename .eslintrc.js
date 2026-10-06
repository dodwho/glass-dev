/** @format */

module.exports = {
    extends: [
        "react-app",
        "eslint:recommended",
        "plugin:react/recommended",
        "plugin:cypress/recommended",
        "plugin:@typescript-eslint/recommended",
    ],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        warnOnUnsupportedTypeScriptVersion: false,
    },
    rules: {
        "no-console": ["warn", { allow: ["debug", "warn", "error"] }],
        "@typescript-eslint/camelcase": "off",
        "@typescript-eslint/explicit-function-return-type": ["off"],
        "unused-imports/no-unused-imports": "warn",
        "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        "react/prop-types": "off",
        "react/display-name": "off",
        "react/react-in-jsx-scope": "off",
        "no-unused-expressions": "off",
        "no-useless-concat": "off",
        "no-useless-constructor": "off",
        "no-unexpected-multiline": "off",
        "default-case": "off",
        "@typescript-eslint/no-use-before-define": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-empty-interface": "off",
        "@typescript-eslint/ban-ts-ignore": "off",
        "@typescript-eslint/no-empty-function": "off",
        "@typescript-eslint/explicit-module-boundary-types": "off",
        "@typescript-eslint/ban-types": "off",
        "@typescript-eslint/ban-ts-comment": "off",
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/indent": "off",
        "@typescript-eslint/member-delimiter-style": "off",
        "@typescript-eslint/type-annotation-spacing": "off",
        "@typescript-eslint/explicit-function-return-type": "off",
        "no-use-before-define": "off",
        "no-debugger": "warn",
        "no-extra-semi": "off",
        "no-mixed-spaces-and-tabs": "off",
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
        "array-callback-return": "off",
        "react/jsx-key": "warn",
        "import/no-restricted-paths": [
            "warn",
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
    overrides: [
        {
            files: ["src/domain/**/*.{ts,tsx}"],
            rules: {
                // The domain layer must not depend on DHIS2 libraries or on the d2-api wrapper.
                // Plain string patterns: the build's ESLint (react-scripts 4) rejects the object form.
                "no-restricted-imports": [
                    "warn",
                    { patterns: ["@eyeseetea/d2-api", "@eyeseetea/d2-api/*", "@dhis2/*", "d2", "**/types/d2-api"] },
                ],
            },
        },
    ],
    plugins: ["cypress", "@typescript-eslint", "react-hooks", "unused-imports"],
    env: { "cypress/globals": true },
    settings: {
        "import/resolver": { node: { extensions: [".js", ".jsx", ".ts", ".tsx"] } },
        react: {
            pragma: "React",
            version: "16.6.0",
        },
    },
};
