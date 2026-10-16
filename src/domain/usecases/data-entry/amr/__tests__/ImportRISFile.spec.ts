import { vi } from "vitest";
import { Future } from "../../../../entities/Future";
import { RISData } from "../../../../entities/data-entry/amr-external/RISData";
import { DataValue } from "../../../../entities/data-entry/DataValue";
import { DataValuesSaveSummary, ImportStrategy } from "../../../../entities/data-entry/DataValuesSaveSummary";
import { GlassModule } from "../../../../entities/GlassModule";
import { CategoryCombo } from "../../../../entities/metadata/CategoryCombo";
import { DataSet } from "../../../../entities/metadata/DataSet";
import { DEFAULT_CATEGORY_COMBO_ID } from "../../../../entities/GlassMetadataReferences";
import { GlassModuleRepository } from "../../../../repositories/GlassModuleRepository";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../../../repositories/data-entry/DataValuesRepository";
import { RISDataRepository } from "../../../../repositories/data-entry/RISDataRepository";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../../utils/getCategoryOptionCombo";
import { AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID } from "../amrAggMetadataIds";
import { ImportRISFile } from "../ImportRISFile";

const option = (code: string) => ({ id: `opt-${code}`, code });

const pathogenAntibioticBatch: CategoryCombo = {
    id: AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID,
    name: "Pathogen, antibiotic, batch",
    categories: [
        { id: "cat-p", code: "PATHOGEN" },
        { id: "cat-a", code: "ANTIBIOTIC" },
        { id: "cat-b", code: "BATCHIDDS" },
    ],
    categoryOptionCombos: [
        { id: "aoc-escc-amp-ds1", name: "", categoryOptions: [option("ESCCOL"), option("AMP"), option("DS1")] },
        { id: "aoc-escc-cip-ds1", name: "", categoryOptions: [option("ESCCOL"), option("CIP"), option("DS1")] },
    ],
};

const demography: CategoryCombo = {
    id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID,
    name: "Specimen, gender, origin, age group",
    categories: [],
    categoryOptionCombos: [
        {
            id: "coc-blood-m-unko-15",
            name: "",
            categoryOptions: [option("BLOOD"), option("M"), option("UNKO"), option("15-24")],
        },
    ],
};

const dataSet: DataSet = {
    id: "ris-ds",
    name: "RIS",
    categoryCombo: AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID,
    dataElements: [
        {
            id: "de-res",
            name: "Resistant",
            code: "RESISTANT",
            categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
        },
        {
            id: "de-sus",
            name: "Susceptible",
            code: "SUSCEPTIBLE",
            categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
        },
        { id: "de-abc", name: "AB class", code: "ABCLASS", categoryCombo: { id: DEFAULT_CATEGORY_COMBO_ID } },
    ],
};

const module = {
    consistencyChecks: { specimenPathogen: { BLOOD: [{ ESCCOL: ["AMP", "CIP"] }] } },
} as unknown as GlassModule;

function risRow(overrides: Partial<RISData> = {}): RISData {
    return {
        COUNTRY: "KOR",
        YEAR: 2025,
        SPECIMEN: "BLOOD",
        GENDER: "M",
        ORIGIN: "UNK",
        AGEGROUP: "15-24",
        BATCHIDDS: "DS1",
        PATHOGEN: "ESCCOL",
        ANTIBIOTIC: "AMP",
        RESISTANT: 3,
        INTERMEDIATE: 0,
        NONSUSCEPTIBLE: 3,
        SUSCEPTIBLE: 10,
        UNKNOWN_NO_AST: 0,
        UNKNOWN_NO_BREAKPOINTS: 0,
        ABCLASS: "ABCLASS Missing",
        ...overrides,
    };
}

const saveSummary: DataValuesSaveSummary = {
    status: "SUCCESS",
    description: "",
    importCount: { imported: 6, updated: 0, ignored: 0, deleted: 0 },
    importTime: new Date("2026-10-16T10:00:00Z"),
};

function setup(
    rows: RISData[],
    validations: { validationRuleViolations: { validationRule: { id: string } }[] }[] = []
) {
    const save = vi.fn((_values: DataValue[], _action: ImportStrategy, _dryRun: boolean) =>
        Future.success(saveSummary)
    );
    const getValidationsDataSet = vi.fn(() => Future.success(validations));
    const risDataRepository = { get: () => Future.success(rows) } as unknown as RISDataRepository;
    const metadataRepository = {
        getDataSet: () => Future.success(dataSet),
        getCategoryCombination: (id: string) =>
            Future.success(id === AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID ? pathogenAntibioticBatch : demography),
        getOrgUnitsByCode: () => Future.success([{ id: "ou-kor", code: "KOR" }]),
        getValidationsDataSet,
        getValidationRuleInstructions: (ids: string[]) =>
            Future.success(ids.map(id => ({ id, instruction: `Rule ${id} failed` }))),
    } as unknown as MetadataRepository;
    const dataValuesRepository = { save } as unknown as DataValuesRepository;
    const moduleRepository = { getByName: () => Future.success(module) } as unknown as GlassModuleRepository;
    const importer = new ImportRISFile(risDataRepository, metadataRepository, dataValuesRepository, moduleRepository);
    const run = (action: ImportStrategy = "CREATE_AND_UPDATE", dryRun = false) =>
        importer.importRISFile({} as File, "DS1", "2025", action, "ou-kor", "KOR", dryRun).toPromise();
    return { run, save, getValidationsDataSet };
}

describe("ImportRISFile", () => {
    it("writes one data value per data element for each row, with the right combinations", async () => {
        const { run, save } = setup([risRow(), risRow({ ANTIBIOTIC: "CIP", RESISTANT: 1, SUSCEPTIBLE: 7 })]);

        const summary = await run();

        expect(summary.status).toBe("SUCCESS");
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0]?.[0]).toEqual([
            {
                orgUnit: "ou-kor",
                period: "2025",
                attributeOptionCombo: "aoc-escc-amp-ds1",
                dataElement: "de-res",
                categoryOptionCombo: "coc-blood-m-unko-15",
                value: "3",
            },
            {
                orgUnit: "ou-kor",
                period: "2025",
                attributeOptionCombo: "aoc-escc-amp-ds1",
                dataElement: "de-sus",
                categoryOptionCombo: "coc-blood-m-unko-15",
                value: "10",
            },
            {
                orgUnit: "ou-kor",
                period: "2025",
                attributeOptionCombo: "aoc-escc-amp-ds1",
                dataElement: "de-abc",
                categoryOptionCombo: "",
                value: "ABCLASS Missing",
            },
            {
                orgUnit: "ou-kor",
                period: "2025",
                attributeOptionCombo: "aoc-escc-cip-ds1",
                dataElement: "de-res",
                categoryOptionCombo: "coc-blood-m-unko-15",
                value: "1",
            },
            {
                orgUnit: "ou-kor",
                period: "2025",
                attributeOptionCombo: "aoc-escc-cip-ds1",
                dataElement: "de-sus",
                categoryOptionCombo: "coc-blood-m-unko-15",
                value: "7",
            },
            {
                orgUnit: "ou-kor",
                period: "2025",
                attributeOptionCombo: "aoc-escc-cip-ds1",
                dataElement: "de-abc",
                categoryOptionCombo: "",
                value: "ABCLASS Missing",
            },
        ]);
        expect(save.mock.calls[0]?.slice(1)).toEqual(["CREATE_AND_UPDATE", false]);
    });

    it("writes nothing and lists every blocking error when a row breaks the rules", async () => {
        const { run, save } = setup([
            risRow({ YEAR: 2024 }),
            risRow({ ANTIBIOTIC: "MEM" }),
            risRow({ ANTIBIOTIC: "CIP", BATCHIDDS: "DS2" }),
        ]);

        const summary = await run();

        expect(save).not.toHaveBeenCalled();
        expect(summary.status).toBe("ERROR");
        expect(summary.importCount.imported).toBe(0);
        const errors = summary.blockingErrors.map(e => `${e.error} [${e.lines}]`);
        expect(errors).toEqual(
            expect.arrayContaining([
                "Year is different: Selected Data Submission Year : 2025, Year in file: 2024 [1]",
                expect.stringContaining("Specimen BLOOD, Pathogen ESCCOL, Antibiotic MEM [2]"),
                "Batchid is different: Selectd batchId to upload: DS1, batchId in file: DS2 [3]",
                expect.stringContaining('not found for codes: "ESCCOL,MEM,DS1"'),
            ])
        );
    });

    it("blocks a result that is not a whole number 0 or higher, before saving anything", async () => {
        const { run, save } = setup([risRow(), risRow({ ANTIBIOTIC: "CIP", INTERMEDIATE: NaN })]);

        const summary = await run();

        expect(save).not.toHaveBeenCalled();
        expect(summary.blockingErrors).toEqual([
            {
                error: "INTERMEDIATE must be a whole number 0 or higher, such as 0, 25 or 1,234",
                count: 1,
                lines: [2],
            },
        ]);
    });

    it("blocks duplicate rows", async () => {
        const { run, save } = setup([risRow(), risRow()]);

        const summary = await run();

        expect(save).not.toHaveBeenCalled();
        expect(summary.blockingErrors).toEqual([expect.objectContaining({ count: 2, lines: [1, 2] })]);
    });

    it("deletes without running the consistency checks", async () => {
        const { run, save } = setup([risRow({ YEAR: 2024 })]);

        const summary = await run("DELETE");

        expect(save).toHaveBeenCalledWith(expect.any(Array), "DELETE", false);
        expect(summary.blockingErrors).toEqual([]);
    });

    const violation = (id: string) => ({
        validationRule: { id, name: `R${id}` },
        leftsideValue: 5,
        rightsideValue: 3,
    });
    const message = (id: string) =>
        `Validation rule 'R${id}' violated. Left side value: '5', right side value: '3'. Instructions: Rule ${id} failed`;

    it("reports DHIS2 validation rule violations after a real import, but not on a dry run", async () => {
        const violations = [{ validationRuleViolations: [violation("vr1")] }];

        const real = setup([risRow()], violations);
        const realSummary = await real.run();
        expect(real.getValidationsDataSet).toHaveBeenCalledWith("CeQPmXgrhHF", "2025", "ou-kor", ["aoc-escc-amp-ds1"]);
        expect(realSummary.status).toBe("ERROR");
        expect(realSummary.blockingErrors).toEqual([{ error: message("vr1"), count: 1 }]);

        const dry = setup([risRow()], violations);
        const drySummary = await dry.run("CREATE_AND_UPDATE", true);
        expect(dry.getValidationsDataSet).not.toHaveBeenCalled();
        expect(drySummary.status).toBe("SUCCESS");
        expect(dry.save).toHaveBeenCalledWith(expect.any(Array), "CREATE_AND_UPDATE", true);
    });

    it("reports each violated validation rule as its own error", async () => {
        const { run } = setup([risRow()], [{ validationRuleViolations: [violation("vr1"), violation("vr2")] }]);

        const summary = await run();

        expect(summary.blockingErrors).toEqual([
            { error: message("vr1"), count: 1 },
            { error: message("vr2"), count: 1 },
        ]);
    });
});
