import _ from "lodash";

const UID_PATTERN = /^[A-Za-z][A-Za-z0-9]{10}$/;

/** Metadata types the ids in GlassMetadataReferences belong to; each is queried once with id:in:[...]. */
export const REFERENCE_METADATA_TYPES = [
    "programs",
    "programStages",
    "dataElements",
    "dataSets",
    "categoryCombos",
    "trackedEntityTypes",
    "trackedEntityAttributes",
] as const;

export type NamedId = { name: string; id: string };

/**
 * Every DHIS2 uid exported by a references module, with the export name (nested objects as `NAME.key`).
 * Constants named *_MODULE_ID are GLASS module ids from the `glass/modules` DataStore key, not metadata,
 * so they are returned separately.
 */
export function collectReferenceIds(references: Record<string, unknown>): {
    metadataIds: NamedId[];
    moduleIds: NamedId[];
} {
    const all = _.flatMap(Object.entries(references), ([name, value]) => {
        if (typeof value === "string") return UID_PATTERN.test(value) ? [{ name, id: value }] : [];
        if (value && typeof value === "object")
            return Object.entries(value as Record<string, unknown>)
                .filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string" && UID_PATTERN.test(entry[1])
                )
                .map(([key, id]) => ({ name: `${name}.${key}`, id }));
        return [];
    });
    const [moduleIds, metadataIds] = _.partition(all, ({ name }) => name.endsWith("_MODULE_ID"));
    return { metadataIds, moduleIds };
}

/** The entries whose id is not in `found`. */
export function findMissing(expected: NamedId[], found: Iterable<string>): NamedId[] {
    const foundIds = new Set(found);
    return expected.filter(({ id }) => !foundIds.has(id));
}
