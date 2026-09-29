import { D2Api } from "@eyeseetea/d2-api/2.34";
import dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BulkLoadDataStoreClient } from "../data/data-store/BulkLoadDataStoreClient";
import { DownloadTemplateDefaultRepository } from "../data/repositories/download-template/DownloadTemplateDefaultRepository";
import { EGASPProgramDefaultRepository } from "../data/repositories/download-template/EGASPProgramDefaultRepository";
import { ExcelPopulateDefaultRepository } from "../data/repositories/ExcelPopulateDefaultRepository";
import { ExcelRepository } from "../domain/repositories/ExcelRepository";
import { AMC_PRODUCT_REGISTER_PROGRAM_ID } from "../domain/usecases/data-entry/amc/ImportAMCProductLevelData";
import { AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID } from "../domain/usecases/data-entry/amc/ImportAMCSubstanceLevelData";
import { describeProgramTarget, DownloadTemplate } from "../domain/utils/DownloadTemplate";
import { setupConsoleLogger } from "../utils/logger";
import { getD2APiFromInstance } from "../utils/d2-api";
import { getEnvVars, getInstance, warmUpSession } from "./common";

dotenv.config();

/*
================================================================
What this script does
================================================================
Produces TWO empty AMC upload templates — one PRODUCT, one SUBSTANCE — whose "Org Unit *" dropdown
lists EVERY country instead of just the one country the web UI happens to be scoped to. No data is
populated: these are blank templates that can be filled in and uploaded for any country and any year.

Why the templates are country-scoped in the UI at all: the ONLY per-country difference in an empty
template is the org unit list (DownloadEmptyTemplateUseCase passes `[orgUnit]`, and that list becomes
the Validation-sheet column backing the "Org Unit *" dropdown plus the Metadata-sheet rows and their
`_<orgUnitId>` defined names — see sheetBuilder.fillValidationSheet / fillMetadataSheet). Columns,
option sets, ATC lists and program stages are identical for every country (filterRawMetadata is a
pass-through), and nothing in an empty template is year-scoped. So widening that one list is all it
takes to get a single template that works everywhere.

Why a script rather than an option on the existing download button: this deliberately touches NO
shared code. It calls the very same DownloadTemplate.downloadTemplate() the web UI calls, with the
same argument values DownloadEmptyTemplateUseCase computes for AMC (see AMC_EMPTY_TEMPLATE_FLAGS
below) — only `orgUnits` differs. Existing frontend behaviour therefore cannot regress.

NOTE on the org unit codes shown in the dropdown: AMC templates are built with
`useCodesForMetadata: true`, so the Metadata sheet (and hence the dropdown) shows each country's
CODE (the M49/ISO numeric code), not its name — exactly as in today's single-country templates, just
with ~200 entries instead of 1. The generated Metadata sheet lists code alongside id, and the run log
below prints the full code -> country name mapping so users can look their code up.

NOTE on runtime: PRODUCT is much slower than SUBSTANCE because it fetches relationship metadata
(downloadRelationships is true for PRODUCT). That cost is identical to what the web UI already pays
for a single-country PRODUCT template — getRelationshipMetadata is not org-unit scoped — so widening
the country list does not make it worse.

Run with:  yarn download-amc-empty-templates
================================================================
CONFIG — edit before a run if needed
================================================================
*/

// Org unit level that represents a country in the GLASS hierarchy. Same value the AMC bulk
// upload/download scripts use (see initializeOrgUnits in bulkDownloadAMUFiles.ts).
const COUNTRY_ORG_UNIT_LEVEL = 3;

// Countries that are NOT at COUNTRY_ORG_UNIT_LEVEL in the metadata tree and so must be added by id.
// Kosovo is the known case, added explicitly by the bulk upload/download scripts for the same reason.
const EXTRA_COUNTRY_ORG_UNIT_IDS: string[] = ["I8AMbKhxlj9"];

// When true, keeps only the countries the AMC program is actually assigned to in DHIS2 — i.e. the
// countries "participating in AMC" — instead of every country in the tree. Assignment is per
// program, so PRODUCT and SUBSTANCE are filtered independently. Left false by default so the
// templates stay usable for any country: an upload for a country that is not assigned to the program
// would be rejected by the tracker anyway, so including it costs nothing but a spare dropdown entry.
const RESTRICT_TO_PROGRAM_ORG_UNITS = false;

const MODULE_NAME = "AMC";

// The two templates to produce. `programId` is used only for the optional program-assignment filter
// and for logging; DownloadTemplate resolves the program itself from moduleName + fileType.
const TEMPLATES = [
    { fileType: "PRODUCT", programId: AMC_PRODUCT_REGISTER_PROGRAM_ID },
    { fileType: "SUBSTANCE", programId: AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID },
] as const;

// EXACTLY the flags DownloadEmptyTemplateUseCase passes for an AMC empty template — kept here as one
// object so any future divergence from the UI is visible in one place:
//   - populate: false            -> no data, blank template (so no dates/periods are needed either)
//   - downloadRelationships      -> true for AMC PRODUCT only
//   - useCodesForMetadata: true  -> AMC (and EGASP) templates identify metadata by code
//   - downloadType omitted       -> for PRODUCT this yields all stages, as the UI template does
const AMC_EMPTY_TEMPLATE_FLAGS = (fileType: string) => ({
    populate: false,
    downloadRelationships: fileType === "PRODUCT",
    useCodesForMetadata: true,
});

type Country = { id: string; name: string; code?: string };

let api!: D2Api;
let downloadTemplate!: DownloadTemplate;

const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");

// Short, filesystem-safe label for the targeted DHIS2 instance, derived from the base URL, so
// templates downloaded from different instances are never mixed up. Same approach as
// bulkDownloadAMUFiles.ts (deliberately algorithmic — no hostname -> name table to keep in sync).
function deriveEnvLabel(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        const hostPrefix = url.hostname.split(".")[0] ?? "";
        const pathTail = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
        return (
            [hostPrefix, pathTail]
                .filter(Boolean)
                .join("-")
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "") || "unknown-env"
        );
    } catch {
        return "unknown-env";
    }
}

const envLabel = deriveEnvLabel(process.env.REACT_APP_DHIS2_BASE_URL ?? "");
const outputDir = path.join(process.cwd(), `AMC_empty_templates_${envLabel}_${runTimestamp}`);

async function initialize(): Promise<void> {
    const instance = getInstance(getEnvVars());
    api = getD2APiFromInstance(instance);
    await warmUpSession(api);
    await setupConsoleLogger({ isDebug: false });

    // The same three repositories DownloadEmptyTemplateUseCase is constructed with in
    // CompositionRoot (minus MetadataRepository, which the use case only uses to expand EGASP
    // clinics/labs — not applicable to AMC).
    downloadTemplate = new DownloadTemplate(
        new DownloadTemplateDefaultRepository(instance),
        new ExcelPopulateDefaultRepository() as ExcelRepository,
        new EGASPProgramDefaultRepository(instance, new BulkLoadDataStoreClient(instance))
    );
}

async function getCountries(): Promise<Country[]> {
    const { objects } = await api.models.organisationUnits
        .get({
            fields: { id: true, name: true, code: true },
            filter: { level: { eq: String(COUNTRY_ORG_UNIT_LEVEL) } },
            paging: false,
        })
        .getData();

    const missingExtras = EXTRA_COUNTRY_ORG_UNIT_IDS.filter(id => !objects.some(ou => ou.id === id));
    const extras = missingExtras.length > 0 ? await getOrgUnitsByIds(missingExtras) : [];

    return [...objects, ...extras];
}

async function getOrgUnitsByIds(ids: string[]): Promise<Country[]> {
    const { objects } = await api.models.organisationUnits
        .get({ fields: { id: true, name: true, code: true }, filter: { id: { in: ids } }, paging: false })
        .getData();

    const notFound = ids.filter(id => !objects.some(ou => ou.id === id));
    if (notFound.length > 0) {
        // Not fatal: an instance simply may not have that org unit (e.g. Kosovo on a test instance).
        console.warn(`[templates] Configured extra org unit(s) not found, skipping: ${notFound.join(", ")}`);
    }

    return objects;
}

// Countries the given program is assigned to in DHIS2 — the metadata definition of "participating".
async function getProgramOrgUnitIds(programId: string): Promise<Set<string>> {
    const { organisationUnits } = await api
        .get<{ organisationUnits: { id: string }[] }>(`/programs/${programId}`, { fields: "organisationUnits[id]" })
        .getData();

    return new Set(organisationUnits.map(orgUnit => orgUnit.id));
}

function describeCountries(countries: Country[]): string {
    return countries
        .map(country => `${country.code ?? "(no code)"} = ${country.name}`)
        .sort()
        .join("\n  ");
}

async function downloadEmptyTemplateForAllCountries(fileType: string, countries: Country[]): Promise<void> {
    const startTime = Date.now();
    console.info(`[templates] Building ${fileType} template for ${countries.length} countries...`);
    console.info(`[templates] Target: ${describeProgramTarget(MODULE_NAME, fileType)}`);

    const file = await downloadTemplate.downloadTemplate({
        moduleName: MODULE_NAME,
        fileType,
        orgUnits: countries.map(country => country.id),
        ...AMC_EMPTY_TEMPLATE_FLAGS(fileType),
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileName = `AMC-${fileType}-ALL_COUNTRIES-TEMPLATE.xlsx`;
    writeFileSync(path.join(outputDir, fileName), bytes);

    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    console.info(`[templates] DONE ${fileName} (${bytes.byteLength} bytes) in ${elapsedSeconds}s`);
}

async function main(): Promise<void> {
    await initialize();

    const countries = await getCountries();
    if (countries.length === 0) throw new Error(`No org units found at level ${COUNTRY_ORG_UNIT_LEVEL}`);

    mkdirSync(outputDir, { recursive: true });
    console.info(`[templates] Output folder: ${outputDir}`);
    console.info(`[templates] ${countries.length} countries found:\n  ${describeCountries(countries)}`);

    const failures: string[] = [];

    for (const { fileType, programId } of TEMPLATES) {
        try {
            const selected = RESTRICT_TO_PROGRAM_ORG_UNITS
                ? await restrictToProgramOrgUnits(countries, programId, fileType)
                : countries;

            await downloadEmptyTemplateForAllCountries(fileType, selected);
        } catch (error) {
            // One file type failing must not lose the other one: report and carry on, then exit
            // non-zero at the end so a failed run is still obvious.
            const message = error instanceof Error ? error.stack ?? error.message : String(error);
            console.error(`[templates] FAILED to build ${fileType} template: ${message}`);
            failures.push(fileType);
        }
    }

    if (failures.length > 0) throw new Error(`Failed to build template(s): ${failures.join(", ")}`);

    console.info("[templates] All templates written.");
}

async function restrictToProgramOrgUnits(
    countries: Country[],
    programId: string,
    fileType: string
): Promise<Country[]> {
    const programOrgUnitIds = await getProgramOrgUnitIds(programId);
    const selected = countries.filter(country => programOrgUnitIds.has(country.id));

    if (selected.length === 0) {
        // Falling back is safer than shipping a template with an empty dropdown, which would be
        // unusable and not obviously broken until someone tried to upload with it.
        console.warn(
            `[templates] ${fileType}: program ${programId} reports no assigned countries — ` +
                `using all ${countries.length} countries instead.`
        );
        return countries;
    }

    console.info(
        `[templates] ${fileType}: restricted to ${selected.length}/${countries.length} countries assigned to ` +
            `program ${programId}.`
    );
    return selected;
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error instanceof Error ? error.stack ?? error.message : error);
        process.exit(1);
    });
