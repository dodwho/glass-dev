import { ATCChangesData, ATCData } from "../../../../../entities/GlassAtcVersionData";
import { SubstanceConsumptionCalculated } from "../../../../../entities/data-entry/amc/SubstanceConsumptionCalculated";
import { createAtcRemapper, matchCalculatedEvents } from "../matchCalculatedEvents";

const currentAtcs: ATCData[] = [
    { CODE: "J01CA04", NAME: "amoxicillin", LEVEL: 5, PATH: "J/J01/J01C/J01CA/J01CA04" },
    { CODE: "J01CR02", NAME: "amoxicillin and beta-lactamase inhibitor", LEVEL: 5, PATH: "J/J01/J01C/J01CR/J01CR02" },
    { CODE: "J01DD04", NAME: "ceftriaxone", LEVEL: 5, PATH: "J/J01/J01D/J01DD/J01DD04" },
];

// J01XX99 was superseded by J01CR02 in the current version.
const atcChanges: ATCChangesData[] = [
    {
        CATEGORY: "ATC",
        CHANGE: "SUPERSEDED",
        INFO: null,
        NEW_ATC: "J01CR02",
        NEW_NAME: null,
        PREVIOUS_ATC: "J01XX99",
        SUBSTANCE_NAME: null,
        YEAR: 2025,
    },
];

const remapAtc = createAtcRemapper(atcChanges, currentAtcs);

function row(overrides: Partial<SubstanceConsumptionCalculated>): SubstanceConsumptionCalculated {
    return {
        atc_autocalculated: "J01CA04",
        route_admin_autocalculated: "O",
        salt_autocalculated: "XXXX",
        combination_code_autocalculated: undefined,
        packages_autocalculated: 10,
        ddds_autocalculated: 100,
        atc_version_autocalculated: "ATC-2025-v1",
        kilograms_autocalculated: 5,
        data_status_autocalculated: 1,
        health_sector_autocalculated: "0",
        health_level_autocalculated: "0",
        am_class: undefined,
        atc2: undefined,
        atc3: undefined,
        atc4: undefined,
        aware: undefined,
        period: "2023",
        orgUnitId: "orgUnit1",
        report_date: "2023-01-01",
        ...overrides,
    };
}

describe("createAtcRemapper", () => {
    it("maps a superseded code onto its current equivalent", () => {
        expect(remapAtc("J01XX99")).toEqual("J01CR02");
    });

    it("leaves an unchanged code alone", () => {
        expect(remapAtc("J01CA04")).toEqual("J01CA04");
    });
});

describe("matchCalculatedEvents", () => {
    it("matches a row whose ATC code did not change", () => {
        const current = [row({ eventId: "event1", ddds_autocalculated: 999 })];
        const next = [row({})];

        const { withEventId, withoutEventId } = matchCalculatedEvents({
            currentRows: current,
            nextRows: next,
            remapAtc,
        });

        expect(withoutEventId).toHaveLength(0);
        expect(withEventId).toHaveLength(1);
        expect(withEventId[0]?.eventId).toEqual("event1");
        // The recalculated value wins; only the identity is taken from the stored event.
        expect(withEventId[0]?.ddds_autocalculated).toEqual(100);
    });

    it("matches a row whose ATC code was remapped by the new version (the data-loss regression)", () => {
        // Stored under the old code, recalculated under the code it was superseded by.
        const current = [row({ eventId: "event1", atc_autocalculated: "J01XX99" })];
        const next = [row({ atc_autocalculated: "J01CR02" })];

        const { withEventId, withoutEventId } = matchCalculatedEvents({
            currentRows: current,
            nextRows: next,
            remapAtc,
        });

        expect(withoutEventId).toHaveLength(0);
        expect(withEventId[0]?.eventId).toEqual("event1");
    });

    it("prefers an exact ATC match over a remapped one", () => {
        const current = [
            row({ eventId: "remapped", atc_autocalculated: "J01XX99" }),
            row({ eventId: "exact", atc_autocalculated: "J01CR02" }),
        ];
        const next = [row({ atc_autocalculated: "J01CR02" })];

        const { withEventId } = matchCalculatedEvents({ currentRows: current, nextRows: next, remapAtc });

        expect(withEventId[0]?.eventId).toEqual("exact");
    });

    it("never claims the same stored event twice", () => {
        const current = [row({ eventId: "event1" })];
        const next = [row({}), row({})];

        const { withEventId, withoutEventId } = matchCalculatedEvents({
            currentRows: current,
            nextRows: next,
            remapAtc,
        });

        expect(withEventId).toHaveLength(1);
        expect(withoutEventId).toHaveLength(1);
        expect(withoutEventId[0]?.eventId).toBeUndefined();
    });

    it("does not match across different identity dimensions", () => {
        const current = [row({ eventId: "event1", health_sector_autocalculated: "1" })];
        const next = [row({ health_sector_autocalculated: "2" })];

        const { withEventId, withoutEventId } = matchCalculatedEvents({
            currentRows: current,
            nextRows: next,
            remapAtc,
        });

        expect(withEventId).toHaveLength(0);
        expect(withoutEventId).toHaveLength(1);
    });

    it("treats the default salt on a recalculated row as matching any stored salt", () => {
        const current = [row({ eventId: "event1", salt_autocalculated: "HCL" })];
        const next = [row({ salt_autocalculated: "XXXX" })];

        const { withEventId } = matchCalculatedEvents({ currentRows: current, nextRows: next, remapAtc });

        expect(withEventId[0]?.eventId).toEqual("event1");
    });

    it("keeps product-level rows of different products apart", () => {
        const current = [
            { ...row({ eventId: "productA" }), AMR_GLASS_AMC_TEA_PRODUCT_ID: "A" },
            { ...row({ eventId: "productB" }), AMR_GLASS_AMC_TEA_PRODUCT_ID: "B" },
        ];
        const next = [{ ...row({}), AMR_GLASS_AMC_TEA_PRODUCT_ID: "B" }];

        const { withEventId } = matchCalculatedEvents({ currentRows: current, nextRows: next, remapAtc });

        expect(withEventId[0]?.eventId).toEqual("productB");
    });

    it("ignores stored rows that carry no event id", () => {
        const current = [row({ eventId: undefined })];
        const next = [row({})];

        const { withEventId, withoutEventId } = matchCalculatedEvents({
            currentRows: current,
            nextRows: next,
            remapAtc,
        });

        expect(withEventId).toHaveLength(0);
        expect(withoutEventId).toHaveLength(1);
    });
});
