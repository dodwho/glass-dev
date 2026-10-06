import { getEnvVars, getTokenMismatchWarning } from "../common";

const tokenVars = [
    "DHIS2_TOKEN_PROD",
    "DHIS2_TOKEN_PREPROD",
    "DHIS2_TOKEN_TRAINING",
    "DHIS2_TOKEN",
    "DHIS2_AUTH",
    "REACT_APP_DHIS2_TOKEN_PROD",
    "REACT_APP_DHIS2_TOKEN_PREPROD",
    "REACT_APP_DHIS2_TOKEN_TRAINING",
    "REACT_APP_DHIS2_TOKEN",
    "REACT_APP_DHIS2_AUTH",
    "REACT_APP_DHIS2_BASE_URL",
];

describe("getEnvVars", () => {
    const saved = { ...process.env };

    beforeEach(() => {
        tokenVars.forEach(name => delete process.env[name]);
        jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        process.env = { ...saved };
        jest.restoreAllMocks();
    });

    it("keeps the original order: prod, preprod, training, then the generic token", () => {
        process.env.REACT_APP_DHIS2_BASE_URL = "https://portal-uat.who.int/dhis2-indiv";
        process.env.DHIS2_TOKEN_PREPROD = "preprod-token";
        process.env.DHIS2_TOKEN = "generic-token";
        expect(getEnvVars()).toEqual({ url: process.env.REACT_APP_DHIS2_BASE_URL, token: "preprod-token" });

        process.env.DHIS2_TOKEN_PROD = "prod-token";
        expect(getEnvVars().token).toBe("prod-token");
    });

    it("still reads the old REACT_APP_ names", () => {
        process.env.REACT_APP_DHIS2_BASE_URL = "https://portal-uat.who.int/dhis2-indiv";
        process.env.REACT_APP_DHIS2_TOKEN_PREPROD = "legacy-preprod-token";
        expect(getEnvVars().token).toBe("legacy-preprod-token");
    });

    it("falls back to basic auth", () => {
        process.env.REACT_APP_DHIS2_BASE_URL = "https://portal-uat.who.int/dhis2-indiv";
        process.env.DHIS2_AUTH = "user:pa:ss";
        expect(getEnvVars().auth).toEqual({ username: "user", password: "pa:ss" });
    });
});

describe("getTokenMismatchWarning", () => {
    it("says nothing when the token matches the instance", () => {
        expect(getTokenMismatchWarning("https://extranet.who.int/dhis2-indiv", "prod")).toBeUndefined();
        expect(getTokenMismatchWarning("https://EXTRANET.who.int/dhis2-indiv/api", "prod")).toBeUndefined();
        expect(getTokenMismatchWarning("https://portal-uat.who.int/dhis2-indiv/", "preprod")).toBeUndefined();
        expect(getTokenMismatchWarning("https://anything.example.org", "generic")).toBeUndefined();
    });

    it("warns when a prod or preprod token goes to another instance, including one on the same host", () => {
        expect(getTokenMismatchWarning("https://portal-uat.who.int/dhis2-indiv", "prod")).toMatch(/not the prod/);
        expect(getTokenMismatchWarning("https://extranet.who.int/dhis2-demo-indiv", "prod")).toMatch(/not the prod/);
        expect(getTokenMismatchWarning("https://extranet.who.int/dhis2-indiv", "preprod")).toMatch(/not the preprod/);
    });
});
