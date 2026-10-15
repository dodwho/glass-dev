/* Read-only access to DHIS2 through the browser-test server's proxy (which holds the login), and a normalised
   snapshot of everything GLASS stores for the test country and year in one module. */
import { dhis2Url, fileMarker, ModuleKey, modules, testYear } from "./config";

export async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${dhis2Url}/api/${path}`);
    if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
}

type DataValue = { dataElement: string; value: string };
type Event = { event?: string; programStage: string; occurredAt: string; status: string; dataValues: DataValue[] };
type TrackedEntity = {
    attributes: { attribute: string; value: string }[];
    enrollments: { enrolledAt: string; occurredAt: string; status: string; events: Event[] }[];
};
type Upload = { id: string; values: Record<string, string> };

/** Each part is a sorted list of lines; a snapshot of an empty country and year has only empty parts. */
export type Snapshot = Record<string, string[]>;

const uploadsProgram = "yVFQpwmCX0D";
const uploadFields = {
    fileName: "EFVhW2HGCX0",
    fileType: "iuKX7DEQmJs",
    status: "hj79iVAy2QK",
    rows: "Br9BBTl7kOA",
    batchId: "dt3jH8M0dlX",
    period: "BXvUeQEf9bT",
    moduleId: "NKDNpVn5FJA",
    calculatedEventList: "jkQyTqUonDr",
};
const yearWindow = (after: string, before: string) => `${after}=${testYear}-01-01&${before}=${testYear}-12-31`;

/** Run-specific values (generated ids, the test year) are replaced so that runs and years compare equal. */
export function normalise(value: string): string {
    if (/^[A-Za-z][A-Za-z0-9]{10}$/.test(value)) return "{UID}";
    return value.replace(new RegExp(`(?<!\\d)${testYear}(?!\\d)`, "g"), "{YEAR}");
}

const dataValuesLine = (dataValues: DataValue[]) =>
    dataValues
        .map(dv => `${dv.dataElement}=${normalise(dv.value)}`)
        .sort()
        .join(" ");

const eventLine = (e: Event) =>
    `${e.programStage} ${normalise(e.occurredAt)} ${e.status} ${dataValuesLine(e.dataValues)}`;

const sorted = (lines: string[]) => [...lines].sort();

function list<T>(response: Record<string, unknown>, name: string): T[] {
    const items = response[name] ?? response.instances;
    if (!Array.isArray(items)) throw new Error(`No ${name} in the DHIS2 response`);
    return items as T[];
}

/** All uploads of the module's test country and year, deleted ones excluded. */
export async function getUploads(module: ModuleKey): Promise<Upload[]> {
    const response = await get<Record<string, unknown>>(
        `tracker/events?program=${uploadsProgram}&orgUnit=${modules[module].country.id}&fields=event,dataValues[dataElement,value]&paging=false`
    );
    return list<Event>(response, "events")
        .map(e => ({
            id: e.event ?? "",
            values: Object.fromEntries(
                Object.entries(uploadFields).map(([key, id]) => [
                    key,
                    e.dataValues.find(dv => dv.dataElement === id)?.value ?? "",
                ])
            ),
        }))
        .filter(u => u.values.period === testYear && u.values.moduleId === modules[module].id);
}

export async function getTestUploadIds(): Promise<Set<string>> {
    const all = await Promise.all((Object.keys(modules) as ModuleKey[]).map(getUploads));
    return new Set(
        all
            .flat()
            .filter(isTestUpload)
            .map(u => u.id)
    );
}

export const isTestUpload = (upload: Upload) => upload.values.fileName?.startsWith(fileMarker) ?? false;

async function events(program: string, orgUnit: string): Promise<string[]> {
    const response = await get<Record<string, unknown>>(
        `tracker/events?program=${program}&orgUnit=${orgUnit}&orgUnitMode=DESCENDANTS&${yearWindow(
            "occurredAfter",
            "occurredBefore"
        )}&fields=programStage,occurredAt,status,dataValues[dataElement,value]&paging=false`
    );
    return sorted(list<Event>(response, "events").map(eventLine));
}

async function trackedEntities(program: string, orgUnit: string, stage?: string): Promise<string[]> {
    const response = await get<Record<string, unknown>>(
        `tracker/trackedEntities?program=${program}&orgUnits=${orgUnit}&${yearWindow(
            "enrollmentEnrolledAfter",
            "enrollmentEnrolledBefore"
        )}&fields=attributes[attribute,value],enrollments[enrolledAt,occurredAt,status,events[programStage,occurredAt,status,dataValues[dataElement,value]]]&paging=false`
    );
    return sorted(
        list<TrackedEntity>(response, "trackedEntities")
            .filter(te => !stage || te.enrollments.some(en => en.events.some(e => e.programStage === stage)))
            .map(te =>
                [
                    te.attributes
                        .map(a => `${a.attribute}=${normalise(a.value)}`)
                        .sort()
                        .join(" "),
                    ...te.enrollments.map(
                        en =>
                            `enrolled ${normalise(en.enrolledAt)} ${en.status}: ` +
                            sorted(en.events.map(eventLine)).join(" ; ")
                    ),
                ].join(" | ")
            )
    );
}

async function dataValues(dataSet: string, orgUnit: string): Promise<string[]> {
    const response = await get<{ dataValues?: (DataValue & Record<string, string>)[] }>(
        `dataValueSets?dataSet=${dataSet}&orgUnit=${orgUnit}&period=${testYear}`
    );
    return sorted(
        (response.dataValues ?? []).map(
            dv => `${dv.dataElement} ${dv.categoryOptionCombo} ${dv.attributeOptionCombo} ${dv.value}`
        )
    );
}

export async function takeSnapshot(module: ModuleKey): Promise<Snapshot> {
    const { id: orgUnit } = modules[module].country;
    const uploads = sorted(
        (await getUploads(module)).map(({ values: u }) =>
            [u.fileType, u.status, u.rows, u.fileName, u.batchId].map(v => normalise(v ?? "")).join(" | ")
        )
    );
    switch (module) {
        case "AMR":
            return {
                uploads,
                ris: await dataValues("CeQPmXgrhHF", orgUnit),
                sample: await dataValues("OcAB7oaC072", orgUnit),
            };
        case "AMR_INDIVIDUAL":
        case "AMR_FUNGAL":
            return { uploads, records: await trackedEntities("mMAj6Gofe49", orgUnit, modules[module].stage) };
        case "AMC":
            return {
                uploads,
                productRegister: await trackedEntities("G6ChA5zMW9n", orgUnit),
                rawSubstanceConsumption: await events("q8aSKr17J5S", orgUnit),
                calculatedConsumption: await events("eUmWZeKZNrg", orgUnit),
            };
        case "EGASP":
            return { uploads, events: await events("SOjanrinfuG", orgUnit) };
    }
}

export const isEmpty = (snapshot: Snapshot) => Object.values(snapshot).every(part => part.length === 0);
