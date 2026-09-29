import {
    ATCChangesData,
    ATCCodeLevel5,
    ATCData,
    DEFAULT_SALT_CODE,
    getNewAtcCodeRecursively,
} from "../../../../entities/GlassAtcVersionData";
import { Id } from "../../../../entities/Ref";
import { Maybe } from "../../../../../types/utils";

/**
 * Matching already-stored calculated events against freshly recalculated rows.
 *
 * The naive approach — compare every `*_autocalculated` field — is wrong, because those fields are
 * OUTPUTS of the calculation. Two of them move when the ATC version changes:
 *
 *   - kilograms/packages/ddds change whenever a DDD changes (already excluded by callers);
 *   - `atc_autocalculated` changes whenever the change table SUPERSEDES a code, which is the very
 *     reason the recalculation is being run.
 *
 * If `atc_autocalculated` is part of the key, a remapped row fails to match its stored event. In
 * UPDATE-only mode (no --calculate) that stored event is then deleted and no replacement is
 * created: silent data loss on exactly the rows the new ATC version was meant to correct.
 *
 * So we match on identity dimensions only, and compare ATC codes after normalising the STORED code
 * through the same change table the new value was produced with. `remapAtc(stored) === next` proves
 * the stored event is the previous incarnation of this row.
 */

export type CalculatedEventIdentity = {
    eventId?: Id;
    // Present at product level only, where rows are additionally scoped to the registered product.
    AMR_GLASS_AMC_TEA_PRODUCT_ID?: string;
    atc_autocalculated: ATCCodeLevel5;
    route_admin_autocalculated: string;
    salt_autocalculated: string;
    combination_code_autocalculated?: string;
    health_sector_autocalculated: string;
    health_level_autocalculated: string;
    data_status_autocalculated: Maybe<number>;
};

export type AtcRemapper = (storedAtcCode: ATCCodeLevel5) => ATCCodeLevel5;

/**
 * Maps an ATC code onto its current-version equivalent, mirroring what the calculation itself does
 * (`getNewAtcCodeRecursively(...) || originalCode`). Memoised: a country/period holds many rows but
 * few distinct ATC codes, and the lookup walks the change table recursively.
 */
export function createAtcRemapper(atcChanges: ATCChangesData[], currentAtcs: ATCData[]): AtcRemapper {
    const cache = new Map<ATCCodeLevel5, ATCCodeLevel5>();

    return storedAtcCode => {
        const cached = cache.get(storedAtcCode);
        if (cached !== undefined) return cached;

        const remapped =
            getNewAtcCodeRecursively({ oldAtcCode: storedAtcCode, atcChanges, currentAtcs }) ?? storedAtcCode;
        cache.set(storedAtcCode, remapped);
        return remapped;
    };
}

// Everything that identifies WHICH row this is, other than the ATC code (handled separately) and the
// salt (compared with the DEFAULT_SALT_CODE wildcard rule below).
function identityKey(row: CalculatedEventIdentity): string {
    return [
        row.AMR_GLASS_AMC_TEA_PRODUCT_ID ?? "",
        row.route_admin_autocalculated,
        row.combination_code_autocalculated ?? "",
        row.health_sector_autocalculated,
        row.health_level_autocalculated,
        row.data_status_autocalculated ?? "",
    ].join("|");
}

// A recalculated row whose salt resolved to the default placeholder matches a stored row of any
// salt: the placeholder means "salt not distinguished", so it subsumes the stored value.
function saltMatches(current: CalculatedEventIdentity, next: CalculatedEventIdentity): boolean {
    return current.salt_autocalculated === next.salt_autocalculated || next.salt_autocalculated === DEFAULT_SALT_CODE;
}

/**
 * Pairs each recalculated row with the stored event it supersedes, if any.
 *
 * Two passes, so an exact ATC match always wins over a remapped one:
 *   1. stored.atc === next.atc                (the unchanged majority)
 *   2. remapAtc(stored.atc) === next.atc      (rows the new ATC version moved)
 *
 * Each stored event is claimed at most once.
 */
export function matchCalculatedEvents<T extends CalculatedEventIdentity>(params: {
    currentRows: T[];
    nextRows: T[];
    remapAtc: AtcRemapper;
}): {
    withEventId: T[];
    withoutEventId: T[];
    /**
     * How many rows matched only via the ATC remap. This is exactly the set that a matcher keyed on
     * `atc_autocalculated` would have failed to match — and therefore deleted. Worth logging: it is
     * the measurable value of the second pass.
     */
    remapMatches: number;
} {
    const { currentRows, nextRows, remapAtc } = params;

    // Index stored rows by identity so matching is O(rows) rather than O(current x next): a large
    // country/period pair holds thousands of rows on both sides.
    const currentByIdentity = new Map<string, T[]>();
    currentRows.forEach(row => {
        if (!row.eventId) return;
        const key = identityKey(row);
        const bucket = currentByIdentity.get(key);
        if (bucket) bucket.push(row);
        else currentByIdentity.set(key, [row]);
    });

    const claimedEventIds = new Set<Id>();
    const withEventId: T[] = [];
    const withoutEventId: T[] = [];

    const claim = (next: T, atcMatches: (current: T) => boolean): Id | undefined => {
        const candidates = currentByIdentity.get(identityKey(next));
        if (!candidates) return undefined;

        const found = candidates.find(
            current =>
                current.eventId !== undefined &&
                !claimedEventIds.has(current.eventId) &&
                saltMatches(current, next) &&
                atcMatches(current)
        );

        return found?.eventId;
    };

    const unmatchedAfterExactPass: T[] = [];
    let remapMatches = 0;

    nextRows.forEach(next => {
        const eventId = claim(next, current => current.atc_autocalculated === next.atc_autocalculated);
        if (eventId) {
            claimedEventIds.add(eventId);
            withEventId.push({ ...next, eventId });
        } else {
            unmatchedAfterExactPass.push(next);
        }
    });

    unmatchedAfterExactPass.forEach(next => {
        const eventId = claim(next, current => remapAtc(current.atc_autocalculated) === next.atc_autocalculated);
        if (eventId) {
            claimedEventIds.add(eventId);
            remapMatches++;
            withEventId.push({ ...next, eventId });
        } else {
            withoutEventId.push({ ...next, eventId: undefined });
        }
    });

    return { withEventId, withoutEventId, remapMatches };
}
