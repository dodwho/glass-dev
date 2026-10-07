import { option, optional, string, Type } from "cmd-ts";
import _ from "lodash";
import { isElementOfUnion } from "../utils/ts-utils";
import { D2Api } from "../types/d2-api";
import { Instance } from "../data/entities/Instance";
import { StatusChangedBy } from "../domain/entities/GlassDataSubmission";
import { Id } from "../domain/entities/Ref";
import { GlassUploadsRepository } from "../domain/repositories/GlassUploadsRepository";
import { RequestUploadDeletionUseCase } from "../domain/usecases/RequestUploadDeletionUseCase";

/**
 * Secrets must not start with REACT_APP_: Create React App copies every REACT_APP_* variable into the built app.
 * The old names are still read, with a warning, so an existing .env keeps working until it is renamed.
 */
function getSecretEnv(name: string): string | undefined {
    const legacyName = `REACT_APP_${name}`;
    if (!process.env[name] && process.env[legacyName] && !warnedLegacyNames.has(legacyName)) {
        warnedLegacyNames.add(legacyName);
        console.warn(`${legacyName} is deprecated: rename it to ${name} in the .env file.`);
    }
    return process.env[name] || process.env[legacyName];
}

const warnedLegacyNames = new Set<string>();

export function getD2Api(url: string): D2Api {
    const token = getSecretEnv("DHIS2_TOKEN");
    if (token) {
        const { baseUrl } = getApiOptionsFromUrl(url);
        return createD2ApiWithToken(baseUrl, token);
    }
    const { baseUrl, auth } = getApiOptionsFromUrl(url);
    return new D2Api({ baseUrl, auth });
}

function getApiOptionsFromUrl(url: string): { baseUrl: string; auth: Auth } {
    const urlObj = new URL(url);
    const decode = decodeURIComponent;
    const auth = { username: decode(urlObj.username), password: decode(urlObj.password) };
    return { baseUrl: urlObj.origin + urlObj.pathname, auth };
}

type Auth = {
    username: string;
    password: string;
};

type D2ApiArgs = {
    url: string;
    auth?: Auth;
    token?: string;
};

export function getD2ApiFromArgs(args: D2ApiArgs): D2Api {
    const token = args.token || getSecretEnv("DHIS2_TOKEN");
    if (token) {
        return createD2ApiWithToken(args.url, token);
    }
    const { baseUrl, auth } = args.auth ? { baseUrl: args.url, auth: args.auth } : getApiOptionsFromUrl(args.url);
    return new D2Api({ baseUrl, auth });
}

export function getInstance(args: D2ApiArgs): Instance {
    const token = args.token || getSecretEnv("DHIS2_TOKEN");
    if (token) {
        return new Instance({ url: args.url, token });
    }
    return new Instance({ url: args.url, ...args.auth });
}

function createD2ApiWithToken(baseUrl: string, token: string): D2Api {
    // Dummy auth forces credentials:"omit"; ApiToken header overrides Basic auth (extraHeaders win in FetchHttpClientRepository)
    const api = new D2Api({ baseUrl, auth: { username: "_", password: "_" } });
    patchWithApiToken(api.baseConnection, token);
    patchWithApiToken(api.apiConnection, token);
    return api;
}

function patchWithApiToken(connection: any, token: string): void {
    const original = connection.request.bind(connection);
    connection.request = (options: any) =>
        original({ ...options, headers: { ...options.headers, Authorization: `ApiToken ${token}` } });
}

/**
 * Connection details for a script that takes them from the environment rather than from --url/--auth.
 *
 * The token env vars are tried in order, so an instance-specific token wins over the generic one and unset names
 * simply fall through. Basic auth is the fallback. A warning is logged when the token does not look like it belongs
 * to the instance in the URL (the choice itself is unchanged, so servers with an internal URL keep working).
 */
export function getEnvVars(): D2ApiArgs {
    const url = process.env.REACT_APP_DHIS2_BASE_URL;
    if (!url) throw new Error("REACT_APP_DHIS2_BASE_URL must be set in the .env file");

    const tokens: [TokenKind, string | undefined][] = [
        ["prod", getSecretEnv("DHIS2_TOKEN_PROD")],
        ["preprod", getSecretEnv("DHIS2_TOKEN_PREPROD")],
        ["training", getSecretEnv("DHIS2_TOKEN_TRAINING")],
        ["generic", getSecretEnv("DHIS2_TOKEN")],
    ];
    const [kind, token] = tokens.find(([, value]) => value) ?? [];

    if (kind && token) {
        const warning = getTokenMismatchWarning(url, kind);
        if (warning) console.warn(warning);
        return { url, token };
    }

    const auth = getSecretEnv("DHIS2_AUTH");
    if (!auth)
        throw new Error(
            "Set one of DHIS2_TOKEN_PROD / DHIS2_TOKEN_PREPROD / DHIS2_TOKEN_TRAINING / DHIS2_TOKEN, or DHIS2_AUTH, in the .env file"
        );

    // Split on the FIRST colon only: passwords may legitimately contain colons.
    const separatorIndex = auth.indexOf(":");
    const username = separatorIndex > 0 ? auth.slice(0, separatorIndex) : "";
    const password = separatorIndex > 0 ? auth.slice(separatorIndex + 1) : "";
    if (!username || !password) throw new Error("DHIS2_AUTH must be in the format 'username:password'");

    return { url, auth: { username, password } };
}

// Host plus first path segment: other instances (e.g. extranet.who.int/dhis2-demo-indiv) share the prod host.
const PROD_INSTANCE = "extranet.who.int/dhis2-indiv";
const PREPROD_INSTANCE = "portal-uat.who.int/dhis2-indiv";

type TokenKind = "prod" | "preprod" | "training" | "generic";

/** A warning when a prod or preprod token is about to be sent to a different instance. */
export function getTokenMismatchWarning(url: string, kind: TokenKind): string | undefined {
    const instance = getInstanceKey(url) ?? url;
    if (kind === "prod" && instance !== PROD_INSTANCE)
        return `Warning: using DHIS2_TOKEN_PROD for ${instance}, which is not the prod instance (${PROD_INSTANCE}).`;
    if (kind === "preprod" && instance !== PREPROD_INSTANCE)
        return `Warning: using DHIS2_TOKEN_PREPROD for ${instance}, which is not the preprod instance (${PREPROD_INSTANCE}).`;
    return undefined;
}

function getInstanceKey(url: string): string | undefined {
    try {
        const { host, pathname } = new URL(url);
        const firstSegment = pathname.split("/").filter(Boolean)[0] ?? "";
        return `${host}/${firstSegment}`.toLowerCase();
    } catch {
        return undefined;
    }
}

/** How the target instance was authenticated, for logging. */
export function describeAuth(envVars: D2ApiArgs): string {
    return envVars.token ? "Personal Access Token" : `basic auth as ${envVars.auth?.username}`;
}

export function getApiUrlOption(options?: { long: string }) {
    return option({
        type: string,
        long: options?.long ?? "url",
        description: "https://[USERNAME:PASSWORD]@HOST:PORT",
    });
}

export function getApiUrlOptions() {
    return {
        url: option({
            type: string,
            long: "url",
            description: "http[s]://[USERNAME:PASSWORD@]HOST:PORT",
        }),
        auth: option({
            type: optional(AuthString),
            long: "auth",
            description: "USERNAME:PASSWORD",
        }),
    };
}

export const AuthString: Type<string, Auth> = {
    async from(str) {
        const [username, password] = str.split(":");
        if (!username || !password) throw new Error(`Invalid pair: ${str} (expected USERNAME:PASSWORD)`);
        return { username, password };
    },
};

/**
 * Splits on whitespace as well as commas. Yarn 1.x on Windows relays arguments through cmd.exe,
 * which treats a comma as an argument separator and hands the script `--orgUnits "id1 id2 id3"` —
 * one value, silently. The list then collapses to a single bogus id and the run reports a scope of
 * 1 pair instead of failing. No org unit id or period contains a space, so accepting both separators
 * costs nothing and removes the trap.
 */
export const StringsSeparatedByCommas: Type<string, string[]> = {
    async from(str) {
        const values = str.split(/[\s,]+/).filter(s => s);
        if (_.isEmpty(values)) throw new Error("Value cannot be empty");
        return values;
    },
};

export function choiceOf<T extends string>(values: readonly T[]): Type<string, T> {
    return {
        async from(str) {
            if (!isElementOfUnion<T>(str, values)) throw new Error(`Valid values: ${values.join(",")}`);
            return str;
        },
    };
}

export function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * DHIS2 workaround: a bug in certain DHIS2 versions causes PAT (Personal Access Token)
 * sessions to fail on the first real API call. Calling GET /me first forces the server
 * to fully initialize the session, after which all subsequent calls succeed normally.
 * Call this once per script run, right after creating the D2Api instance.
 */
export async function warmUpSession(api: D2Api): Promise<void> {
    const user = await api.get<{ id: string; username: string }>("/me").getData();
    console.log(`[auth] Session initialized for user: ${user.username} (${user.id})`);
}

export const deletionReasonOption = option({
    type: string,
    long: "reason",
    description: "Why the files are deleted. Recorded in the audit trail with the token owner",
});

/** Records the token owner and the reason on the upload event, so it is kept as the audit trail once the upload is deleted. */
export function recordDeletionRequest(
    glassUploadsRepository: GlassUploadsRepository,
    params: { uploadId: Id; tokenOwner: StatusChangedBy; reason: string }
): Promise<void> {
    return new RequestUploadDeletionUseCase(glassUploadsRepository)
        .execute({ uploadIds: [params.uploadId], requestedBy: params.tokenOwner.username, reason: params.reason })
        .toPromise();
}

/** The user that owns the token the script runs with, recorded as the author of audit-trail entries. */
export async function getTokenOwner(api: D2Api): Promise<StatusChangedBy> {
    const { id, username } = await api.get<StatusChangedBy>("/me?fields=id,username").getData();
    return { id, username };
}
