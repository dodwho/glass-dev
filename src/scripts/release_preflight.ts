/*
================================================================
Release preflight — READ ONLY, writes nothing to DHIS2
================================================================
Checks that the DHIS2 instance in REACT_APP_DHIS2_BASE_URL has the metadata this version of the app
depends on, before the app is installed there:

  1. Every data element the app reads or writes on the uploads program stage is in that stage
     (including the audit-trail "deletion requested by / at / reason" ones: without them every
     deletion stops with "Error occurred when recording the deletion request").
  2. Every id in GlassMetadataReferences exists (programs, stages, data elements, data sets,
     category combos, tracked entity types and attributes).
  3. Every GLASS module id is in the `glass/modules` DataStore key, and prints the upload settings
     of AMR - Individual and AMR - Fungal.

Exits with code 1 if anything is missing.

Run with:  yarn release-preflight
*/

import dotenv from "dotenv";

import { D2Api } from "../types/d2-api";
import { getD2APiFromInstance } from "../utils/d2-api";
import { describeAuth, getEnvVars, getInstance, warmUpSession } from "./common";
import * as references from "../domain/entities/GlassMetadataReferences";
import {
    AMR_GLASS_PROE_UPLOADS_PROGRAM_STAGE_ID,
    uploadsDHIS2Ids,
} from "../data/repositories/GlassUploadsProgramRepository";
import { GlassModule } from "../domain/entities/GlassModule";
import { collectReferenceIds, findMissing, NamedId, REFERENCE_METADATA_TYPES } from "./utils/releasePreflightChecks";

dotenv.config({ path: ".env.local" });
dotenv.config();

async function getUploadStageDataElementIds(api: D2Api): Promise<string[]> {
    const stage = await api
        .get<{ programStageDataElements: { dataElement: { id: string } }[] }>(
            `/programStages/${AMR_GLASS_PROE_UPLOADS_PROGRAM_STAGE_ID}`,
            { fields: "programStageDataElements[dataElement[id]]" }
        )
        .getData();
    return stage.programStageDataElements.map(psde => psde.dataElement.id);
}

async function getExistingMetadataIds(api: D2Api, ids: string[]): Promise<string[]> {
    const responses = await Promise.all(
        REFERENCE_METADATA_TYPES.map(type =>
            api
                .get<Record<string, { id: string }[]>>(`/${type}`, {
                    filter: `id:in:[${ids.join(",")}]`,
                    fields: "id",
                    paging: false,
                })
                .getData()
                .then(response => response[type] ?? [])
        )
    );
    return responses.flat().map(({ id }) => id);
}

function report(title: string, missing: NamedId[]): boolean {
    if (missing.length === 0) {
        console.log(`OK    ${title}`);
        return true;
    }
    console.log(`FAIL  ${title}: ${missing.length} missing`);
    missing.forEach(({ name, id }) => console.log(`        ${id}  ${name}`));
    return false;
}

async function main(): Promise<void> {
    const envVars = getEnvVars();
    const api = getD2APiFromInstance(getInstance(envVars));
    console.log(`[auth] ${envVars.url} using ${describeAuth(envVars)}`);
    await warmUpSession(api);

    const { version } = await api.get<{ version: string }>("/system/info", { fields: "version" }).getData();
    console.log(`DHIS2 version ${version}\n`);

    const uploadDataElements = Object.entries(uploadsDHIS2Ids).map(([name, id]) => ({ name, id }));
    const uploadsOk = report(
        `Uploads program stage ${AMR_GLASS_PROE_UPLOADS_PROGRAM_STAGE_ID} has every upload data element`,
        findMissing(uploadDataElements, await getUploadStageDataElementIds(api))
    );

    const { metadataIds, moduleIds } = collectReferenceIds(references);
    const metadataOk = report(
        `All ${metadataIds.length} ids in GlassMetadataReferences exist`,
        findMissing(
            metadataIds,
            await getExistingMetadataIds(
                api,
                metadataIds.map(({ id }) => id)
            )
        )
    );

    const modules = await api.get<GlassModule[]>("/dataStore/glass/modules").getData();
    const modulesOk = report(
        "glass/modules has every GLASS module",
        findMissing(
            moduleIds,
            modules.map(module => module.id)
        )
    );

    console.log("\nUpload settings in glass/modules (blank = code default):");
    modules
        .filter(module => module.name === "AMR - Individual" || module.name === "AMR - Fungal")
        .forEach(module =>
            console.log(
                `  ${module.name}: maxNumberOfRowsToSyncUploads=${
                    module.maxNumberOfRowsToSyncUploads ?? ""
                }, asyncUploadMaxConcurrency=${module.asyncUploadMaxConcurrency ?? ""}`
            )
        );

    if (!(uploadsOk && metadataOk && modulesOk)) {
        console.log("\nNOT READY: import the missing metadata before installing this version.");
        process.exitCode = 1;
    } else {
        console.log("\nREADY: this instance has the metadata the app needs.");
    }
}

main().catch(error => {
    // Never print the error object: it carries the request headers, including the access token.
    const status = error?.response?.status ? ` (HTTP ${error.response.status})` : "";
    console.error(`Preflight failed${status}: ${error?.response?.data?.message ?? error?.message ?? error}`);
    process.exitCode = 1;
});
