import { RawSubstanceConsumptionCalculated } from "../../../../../entities/data-entry/amc/RawSubstanceConsumptionCalculated";
import { mapRawSubstanceCalculatedToSubstanceCalculated } from "../mapRawSubstanceCalculatedToSubstanceCalculated";

function raw(overrides: Partial<RawSubstanceConsumptionCalculated> = {}): RawSubstanceConsumptionCalculated {
    return {
        AMR_GLASS_AMC_TEA_PRODUCT_ID: "P1",
        atc_autocalculated: "J01CA04",
        route_admin_autocalculated: "O",
        salt_autocalculated: "XXXX",
        combination_code_autocalculated: undefined,
        packages_autocalculated: 10,
        ddds_autocalculated: 100,
        atc_version_autocalculated: "ATC-2024-v1",
        kilograms_autocalculated: 1.5,
        data_status_autocalculated: 1,
        health_sector_autocalculated: "1",
        health_level_autocalculated: "1",
        am_class: "Penicillins",
        atc2: "J01",
        atc3: "J01C",
        atc4: "J01CA",
        aware: "Access",
        orgUnitId: "MLT",
        ...overrides,
    } as unknown as RawSubstanceConsumptionCalculated;
}

describe("mapRawSubstanceCalculatedToSubstanceCalculated", () => {
    it("adds up packages, DDDs and kilograms of products with the same substance and context", () => {
        const result = mapRawSubstanceCalculatedToSubstanceCalculated(
            [
                raw({ AMR_GLASS_AMC_TEA_PRODUCT_ID: "P1" }),
                raw({
                    AMR_GLASS_AMC_TEA_PRODUCT_ID: "P2",
                    packages_autocalculated: 5,
                    ddds_autocalculated: 40,
                    kilograms_autocalculated: 0.5,
                }),
            ],
            "2024"
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            atc_autocalculated: "J01CA04",
            packages_autocalculated: 15,
            ddds_autocalculated: 140,
            kilograms_autocalculated: 2,
            period: "2024",
            orgUnitId: "MLT",
            report_date: "2024-01-01",
            atc_version_autocalculated: "ATC-2024-v1",
        });
    });

    it("keeps separate rows for a different route, salt, combination, health sector, health level or data status", () => {
        const result = mapRawSubstanceCalculatedToSubstanceCalculated(
            [
                raw(),
                raw({ route_admin_autocalculated: "P" }),
                raw({ salt_autocalculated: "HIPP" }),
                raw({ combination_code_autocalculated: "COMB_1" }),
                raw({ health_sector_autocalculated: "2" }),
                raw({ health_level_autocalculated: "2" }),
                raw({ data_status_autocalculated: 2 }),
            ],
            "2024"
        );

        expect(result).toHaveLength(7);
    });

    it("treats a missing value as nothing to add, and keeps a missing total missing", () => {
        const result = mapRawSubstanceCalculatedToSubstanceCalculated(
            [
                raw({
                    packages_autocalculated: undefined,
                    ddds_autocalculated: undefined,
                    kilograms_autocalculated: undefined,
                }),
                raw({
                    packages_autocalculated: undefined,
                    ddds_autocalculated: 7,
                    kilograms_autocalculated: undefined,
                }),
            ],
            "2024"
        );

        expect(result[0]).toMatchObject({
            packages_autocalculated: undefined,
            ddds_autocalculated: 7,
            kilograms_autocalculated: undefined,
        });
    });

    it("starts from zero when the first product has no value but a later one has", () => {
        const result = mapRawSubstanceCalculatedToSubstanceCalculated(
            [raw({ packages_autocalculated: undefined }), raw({ packages_autocalculated: 4 })],
            "2024"
        );

        expect(result[0]?.packages_autocalculated).toBe(4);
    });

    it("returns nothing for no products", () => {
        expect(mapRawSubstanceCalculatedToSubstanceCalculated([], "2024")).toEqual([]);
    });
});
