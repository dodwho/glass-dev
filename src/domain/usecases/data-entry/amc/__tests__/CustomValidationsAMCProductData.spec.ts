import { Future } from "../../../../entities/Future";
import { Country } from "../../../../entities/Country";
import { GlassAtcVersionData } from "../../../../entities/GlassAtcVersionData";
import { TrackerTrackedEntity } from "../../../../entities/TrackedEntityInstance";
import {
    AMR_GLASS_AMC_TEA_ATC,
    AMR_GLASS_AMC_TEA_COMBINATION,
    AMR_GLASS_AMC_TEA_PRODUCT_ID,
    AMR_GLASS_AMC_TEA_ROUTE_ADMIN,
} from "../../../../entities/data-entry/amc/amcProgramIds";
import { AMCProductDataRepository } from "../../../../repositories/data-entry/AMCProductDataRepository";
import { GlassATCRepository } from "../../../../repositories/GlassATCRepository";
import { CustomValidationsAMCProductData } from "../CustomValidationsAMCProductData";

const country = { id: "MLT", name: "Malta" };

const atcVersion = {
    atcs: [
        { CODE: "J01CA04", NAME: "amoxicillin", LEVEL: 5, PATH: "" },
        { CODE: "J01CA", NAME: "Penicillins with extended spectrum", LEVEL: 4, PATH: "" },
        { CODE: "J01XX08", NAME: "linezolid", LEVEL: 5, PATH: "" },
    ],
    changes: [
        {
            CATEGORY: "ATC",
            CHANGE: "SUPERSEDED",
            PREVIOUS_ATC: "J01AA99",
            NEW_ATC: "J01XX08",
            INFO: null,
            NEW_NAME: null,
            SUBSTANCE_NAME: null,
            YEAR: 2023,
        },
        {
            CATEGORY: "ATC",
            CHANGE: "DELETED",
            PREVIOUS_ATC: "J01ZZ01",
            NEW_ATC: "",
            INFO: null,
            NEW_NAME: null,
            SUBSTANCE_NAME: null,
            YEAR: 2023,
        },
    ],
    combinations: [{ COMB_CODE: "COMB_1", ATC5: "J01CA04", ROA: "O" }],
} as unknown as GlassAtcVersionData;

/** A product row from a product-level file. Rows are numbered by trackedEntity from 0: the Excel line is that plus 6. */
function product(
    row: number,
    attributes: Record<string, string> = {},
    overrides: Partial<TrackerTrackedEntity> = {},
    enrolledAt = "2024-01-01T00:00"
): TrackerTrackedEntity {
    return {
        trackedEntity: String(row),
        trackedEntityType: "tet",
        orgUnit: country.id,
        attributes: Object.entries({ [AMR_GLASS_AMC_TEA_PRODUCT_ID]: `P${row}`, ...attributes }).map(
            ([attribute, value]) => ({
                attribute,
                value,
            })
        ),
        enrollments: [{ enrolledAt }],
        ...overrides,
    } as unknown as TrackerTrackedEntity;
}

function validate(teis: TrackerTrackedEntity[], existingProductIds: string[] = [], period = "2024") {
    const validator = new CustomValidationsAMCProductData(
        { getCurrentAtcVersion: () => Future.success(atcVersion) } as unknown as GlassATCRepository,
        {
            getTrackedEntityProductIdsByOUAndPeriod: () => Future.success(existingProductIds),
        } as unknown as AMCProductDataRepository
    );
    return validator.getValidatedEvents(teis, country.id, country.name, period, [] as Country[]).toPromise();
}

describe("CustomValidationsAMCProductData", () => {
    it("accepts a clean file", async () => {
        const result = await validate([
            product(0, {
                [AMR_GLASS_AMC_TEA_ATC]: "J01CA04",
                [AMR_GLASS_AMC_TEA_COMBINATION]: "COMB_1",
                [AMR_GLASS_AMC_TEA_ROUTE_ADMIN]: "O",
            }),
            product(1, { [AMR_GLASS_AMC_TEA_ATC]: "J01XX08" }),
        ]);

        expect(result.blockingErrors).toEqual([]);
        expect(result.nonBlockingErrors).toEqual([]);
    });

    describe("product ids", () => {
        // Current behaviour, recorded on purpose: the lines are row numbers (counted from 0), not Excel lines (+6) like the
        // other errors, and row 0 is dropped from the list (compact() removes the number 0), so only line 1 is shown.
        it("blocks the same product id twice in the file", async () => {
            const result = await validate([
                product(0, { [AMR_GLASS_AMC_TEA_PRODUCT_ID]: "P-A" }),
                product(1, { [AMR_GLASS_AMC_TEA_PRODUCT_ID]: "P-A" }),
            ]);

            expect(result.blockingErrors).toEqual([
                { error: "This Product ID already exists : P-A", lines: [1], count: 2 },
            ]);
        });

        it("blocks a product id already registered for the country and period", async () => {
            const result = await validate([product(3, { [AMR_GLASS_AMC_TEA_PRODUCT_ID]: "P-OLD" })], ["P-OLD"]);

            expect(result.blockingErrors).toEqual([
                { error: "This Product ID already exists : P-OLD", lines: [3], count: 2 },
            ]);
        });

        it("does not block duplicates that exist only in DHIS2", async () => {
            const result = await validate([product(0)], ["P-X", "P-X"]);

            expect(result.blockingErrors).toEqual([]);
        });
    });

    describe("country and year", () => {
        it("blocks rows of another country, numbering lines as row + 6", async () => {
            const result = await validate([product(0), product(2, {}, { orgUnit: "ITA" })]);

            expect(result.blockingErrors).toEqual([
                {
                    error: "Selected Country is incorrect: Selected country : Malta, country in file: ITA",
                    count: 1,
                    lines: [8],
                },
            ]);
        });

        it("blocks an enrolment date in another year", async () => {
            const teis = [product(0, {}, {}, "2023-12-31T00:00"), product(1, {}, {}, "2023-12-31T00:00")];

            const errors = (await validate(teis)).blockingErrors;

            expect(errors).toEqual([
                {
                    error: "Event date is incorrect: Selected period : 2024, date in file: 2023-12-31",
                    count: 2,
                    lines: [6, 7],
                },
            ]);
        });

        it("blocks a file whose rows have different enrolment dates", async () => {
            const teis = [product(0, {}, {}, "2024-01-01T00:00"), product(1, {}, {}, "2024-06-01T00:00")];

            const errors = (await validate(teis)).blockingErrors;

            expect(errors).toEqual([
                { error: "All TEI instances in the file should have the same enrollment date ", count: 2 },
            ]);
        });
    });

    describe("ATC code", () => {
        it("accepts a level 5 code and the code for products without an ATC", async () => {
            const result = await validate([
                product(0, { [AMR_GLASS_AMC_TEA_ATC]: "J01CA04" }),
                product(1, { [AMR_GLASS_AMC_TEA_ATC]: "Z99ZZ99" }),
            ]);

            expect(result.blockingErrors).toEqual([]);
        });

        it("accepts an old code that was superseded by a current one", async () => {
            const result = await validate([product(0, { [AMR_GLASS_AMC_TEA_ATC]: "J01AA99" })]);

            expect(result.blockingErrors).toEqual([]);
        });

        it("blocks a level 4 code, a deleted code and an unknown code", async () => {
            const result = await validate([
                product(0, { [AMR_GLASS_AMC_TEA_ATC]: "J01CA" }),
                product(1, { [AMR_GLASS_AMC_TEA_ATC]: "J01ZZ01" }),
                product(2, { [AMR_GLASS_AMC_TEA_ATC]: "NOPE" }),
            ]);

            const message = (code: string) =>
                `ATC code specified in the file is not a valid level 5 ATC code : ${code}`;
            expect(result.blockingErrors).toEqual([
                { error: message("J01CA"), count: 1, lines: [6] },
                { error: message("J01ZZ01"), count: 1, lines: [7] },
                { error: message("NOPE"), count: 1, lines: [8] },
            ]);
        });
    });

    describe("combination code and route of administration", () => {
        it("blocks an unknown combination code but accepts the one for products without an ATC", async () => {
            const result = await validate([
                product(0, { [AMR_GLASS_AMC_TEA_COMBINATION]: "COMB_X" }),
                product(1, { [AMR_GLASS_AMC_TEA_COMBINATION]: "Z99ZZ99_99" }),
            ]);

            expect(result.blockingErrors).toEqual([
                {
                    error: "Combination code specified in the file is not a valid combination code : COMB_X",
                    count: 1,
                    lines: [6],
                },
            ]);
        });

        it("blocks a route of administration that does not match the combination's route", async () => {
            const result = await validate([
                product(0, { [AMR_GLASS_AMC_TEA_COMBINATION]: "COMB_1", [AMR_GLASS_AMC_TEA_ROUTE_ADMIN]: "P" }),
            ]);

            expect(result.blockingErrors).toHaveLength(1);
            expect(result.blockingErrors[0]?.error).toContain(
                "Route of Administration specified in the file : P is not valid for given combination code : COMB_1"
            );
            expect(result.blockingErrors[0]?.error).toContain("It should be O");
        });

        it("does not check the route when there is no combination code", async () => {
            const result = await validate([product(0, { [AMR_GLASS_AMC_TEA_ROUTE_ADMIN]: "P" })]);

            expect(result.blockingErrors).toEqual([]);
        });
    });
});
