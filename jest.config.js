module.exports = {
    collectCoverageFrom: ["src/**/*.js"],
    testPathIgnorePatterns: ["/node_modules/", "/cypress", "/e2e/"],
    // @eyeseetea/d2-api depends on axios 1.x, which ships ESM-only, so it must be transformed too. axios is
    // hoisted today, but the `.*axios` alternative also matches a nested copy: this pattern is unanchored, so
    // without it the outer `node_modules/` position (followed by `@eyeseetea/d2-api`) would match and the
    // whole path would be skipped. The character class accepts both separators so the pattern also works
    // on Windows.
    transformIgnorePatterns: ["node_modules[\\\\/](?!(@eyeseetea[\\\\/]d2-ui-components|.*axios))"],
    modulePaths: ["src"],
    moduleDirectories: ["node_modules"],
    moduleNameMapper: {
        "\\.(css|scss)$": "<rootDir>/config/styleMock.js",
        "\\.(jpg|jpeg|png|svg)$": "<rootDir>/config/fileMock.js",
    },
    transform: {
        "^.+\\.[t|j]sx?$": "babel-jest",
    },
    testRegex: "((\\.|/)(test|spec))\\.(jsx?|tsx?)$",
    moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
    testEnvironment: "jsdom",
    globals: {
        window: true,
        document: true,
        navigator: true,
        Element: true,
    },
};
