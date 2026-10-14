import _ from "lodash";
import { Instance } from "../data/entities/Instance";
import { D2Api, D2ApiOptions } from "../types/d2-api";

export function getMajorVersion(version: string): number {
    const apiVersion = _.get(version.split("."), 1);
    if (!apiVersion) throw new Error(`Invalid version: ${version}`);
    return Number(apiVersion);
}

export function getD2APiFromInstance(instance: Instance): D2Api {
    return new D2Api({ baseUrl: instance.url, auth: getD2ApiAuth(instance), backend: "fetch" });
}

/**
 * A personal access token goes through d2-api's own token auth ("ApiToken" header, credentials "omit"),
 * so it is added when the request is sent and never stored in the request options, which d2-api includes
 * in its HttpError and debug output.
 */
export function getD2ApiAuth(instance: Instance): D2ApiOptions["auth"] {
    return instance.token ? { type: "personalToken", token: instance.token } : instance.auth;
}
