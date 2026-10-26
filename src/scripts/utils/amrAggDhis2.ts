import { option, optional } from "cmd-ts";
import _ from "lodash";
import { D2Api } from "@eyeseetea/d2-api/2.41";
import { DataValueSetsDataValue } from "@eyeseetea/d2-api/api";

import { Instance } from "../../data/entities/Instance";
import { MetadataDefaultRepository } from "../../data/repositories/MetadataDefaultRepository";
import {
    AMR_AMR_DS_INPUT_FILES_RIS_DS_ID,
    AMR_AMR_DS_Input_files_Sample_DS_ID,
    AMR_BATCHID_CC_ID,
    AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID,
} from "../../domain/usecases/data-entry/amr/amrAggMetadataIds";
import { AMRAggFileMetadata } from "../../domain/usecases/data-entry/amr/mapAMRAggFileToDataValues";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../../domain/usecases/data-entry/utils/getCategoryOptionCombo";
import { retryAsync } from "../../utils/promises";
import { choiceOf } from "../common";
import { AMR_AGG_FILE_TYPES, AmrAggFileType, getAocTranslator, getBatchCodeByAoc } from "./amrAggOrphans";

/*
 * DHIS2 access shared by the AMR aggregate scripts (amr_agg_orphans, amr_agg_bulk_upload), so they pick the instance,
 * read stored values and tell which batch a value belongs to in exactly the same way.
 */

const INSTANCES = {
    prod: { url: "https://extranet.who.int/dhis2-indiv", tokenName: "DHIS2_TOKEN_PROD" },
    preprod: { url: "https://portal-uat.who.int/dhis2-indiv", tokenName: "DHIS2_TOKEN_PREPROD" },
} as const;
export type InstanceName = keyof typeof INSTANCES;

/**
 * Points this run at prod or preprod with that instance's own token from .env.local. The other credentials are
 * cleared for this process only (getEnvVars takes the first token it finds), so a token can't reach the wrong server.
 */
export function selectInstance(name: InstanceName) {
    const { url, tokenName } = INSTANCES[name];
    const token = process.env[tokenName] || process.env[`REACT_APP_${tokenName}`];
    if (!token) throw new Error(`--instance ${name} needs ${tokenName} in .env.local`);
    for (const secret of [
        "DHIS2_TOKEN_PROD",
        "DHIS2_TOKEN_PREPROD",
        "DHIS2_TOKEN_TRAINING",
        "DHIS2_TOKEN",
        "DHIS2_AUTH",
    ])
        for (const variable of [secret, `REACT_APP_${secret}`]) process.env[variable] = "";
    process.env[tokenName] = token;
    process.env.REACT_APP_DHIS2_BASE_URL = url;
}

export const instanceArg = option({
    type: optional(choiceOf(["prod", "preprod"] as const)),
    long: "instance",
    description: "prod or preprod, with DHIS2_TOKEN_PROD / DHIS2_TOKEN_PREPROD from .env.local (default: the .env URL)",
});

export const BATCH_CATEGORY_CODE = "BATCHIDDS";

export const DATA_SETS: Record<AmrAggFileType, { dataSetId: string; categoryComboId: string }> = {
    RIS: { dataSetId: AMR_AMR_DS_INPUT_FILES_RIS_DS_ID, categoryComboId: AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID },
    SAMPLE: { dataSetId: AMR_AMR_DS_Input_files_Sample_DS_ID, categoryComboId: AMR_BATCHID_CC_ID },
};

/** Kosovo is not a level-3 org unit on every instance, so the AMC/AMR scripts add it by uid. */
const KOSOVO_ORG_UNIT_ID = "I8AMbKhxlj9";

/** The server closed the connection (preprod and prod both do under load, or on a connection left idle). */
export const isDroppedConnection = (error: unknown) => /socket hang up|ECONNRESET|ETIMEDOUT/i.test(String(error));

export type Country = { id: string; code: string };

/** Every country (level 3, plus Kosovo) with a code. */
export async function getCountries(api: D2Api): Promise<Country[]> {
    const levelThree = await api.models.organisationUnits
        .get({ fields: { id: true, code: true }, filter: { level: { eq: "3" } }, paging: false })
        .getData();
    const kosovo = await api.models.organisationUnits
        .get({ fields: { id: true, code: true }, filter: { id: { eq: KOSOVO_ORG_UNIT_ID } } })
        .getData();
    return _.uniqBy([...levelThree.objects, ...kosovo.objects], ou => ou.id).filter((ou): ou is Country =>
        Boolean(ou.code)
    );
}

export interface AmrAggMetadata {
    batchCodeByAoc: Record<AmrAggFileType, Map<string, string>>;
    aocTranslators: Record<AmrAggFileType, (aoc: string, batchCode: string) => string | undefined>;
    batchCodes: string[];
    /** What the app's import reads, so a file maps to exactly the values it imported. */
    fileMetadata: Record<AmrAggFileType, AMRAggFileMetadata>;
    zeroNotStoredDataElements: Set<string>;
}

export async function getAmrAggMetadata(api: D2Api, instance: Instance, countries: Country[]): Promise<AmrAggMetadata> {
    const combos = await api.models.categoryCombos
        .get({
            fields: {
                id: true,
                categories: { code: true, categoryOptions: { id: true, code: true } },
                categoryOptionCombos: { id: true, categoryOptions: { id: true } },
            },
            filter: { id: { in: Object.values(DATA_SETS).map(dataSet => dataSet.categoryComboId) } },
            paging: false,
        })
        .getData();

    const comboOf = (categoryComboId: string) => {
        const combo = combos.objects.find(object => object.id === categoryComboId);
        if (!combo) throw new Error(`Category combo ${categoryComboId} not found on this instance`);
        return combo;
    };
    const batchCodeByAoc = _.mapValues(DATA_SETS, ({ categoryComboId }) =>
        getBatchCodeByAoc(comboOf(categoryComboId), BATCH_CATEGORY_CODE)
    );
    const aocTranslators = _.mapValues(DATA_SETS, ({ categoryComboId }) =>
        getAocTranslator(comboOf(categoryComboId), BATCH_CATEGORY_CODE)
    );
    const batchCodes = _.uniq(Object.values(batchCodeByAoc).flatMap(byAoc => [...byAoc.values()])).sort();

    const metadataRepository = new MetadataDefaultRepository(instance);
    const dataElement_CC = await metadataRepository
        .getCategoryCombination(AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID)
        .toPromise();
    const fileMetadata = {} as Record<AmrAggFileType, AMRAggFileMetadata>;
    for (const fileType of AMR_AGG_FILE_TYPES) {
        const { dataSetId, categoryComboId } = DATA_SETS[fileType];
        fileMetadata[fileType] = {
            dataSet: await metadataRepository.getDataSet(dataSetId).toPromise(),
            dataSet_CC: await metadataRepository.getCategoryCombination(categoryComboId).toPromise(),
            dataElement_CC,
            orgUnits: countries,
        };
    }

    const dataSets = await api.models.dataSets
        .get({
            fields: { dataSetElements: { dataElement: { id: true, zeroIsSignificant: true } } },
            filter: { id: { in: Object.values(DATA_SETS).map(dataSet => dataSet.dataSetId) } },
            paging: false,
        })
        .getData();
    const zeroNotStoredDataElements = new Set(
        dataSets.objects
            .flatMap(dataSet => dataSet.dataSetElements.map(element => element.dataElement))
            .filter(dataElement => !dataElement.zeroIsSignificant)
            .map(dataElement => dataElement.id)
    );

    return { batchCodeByAoc, aocTranslators, batchCodes, fileMetadata, zeroNotStoredDataElements };
}

/** Every value stored in one data set for one country and year. */
export async function readStoredValues(
    api: D2Api,
    fileType: AmrAggFileType,
    orgUnitId: string,
    year: string
): Promise<DataValueSetsDataValue[]> {
    // Up to about 2.5 minutes of retries: a full scan is long enough to meet a bad patch on the server.
    const response = await retryAsync(
        () =>
            api.dataValues
                .getSet({ dataSet: [DATA_SETS[fileType].dataSetId], orgUnit: [orgUnitId], period: [year] })
                .getData(),
        { attempts: 6, baseDelayMs: 5000 }
    );
    return response.dataValues;
}
