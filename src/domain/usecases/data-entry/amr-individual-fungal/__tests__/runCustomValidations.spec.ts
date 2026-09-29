import { CustomDataColumns } from "../../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { runCustomValidations } from "../common";

function row(sampleDate: string): CustomDataColumns {
    return [
        { key: "COUNTRY", type: "string", value: "CPV" },
        { key: "YEAR", type: "number", value: 2024 },
        { key: "PATIENT_ID", type: "string", value: "patient" },
        { key: "PATIENTCOUNTER", type: "number", value: 1 },
        { key: "SAMPLE_DATE", type: "string", value: sampleDate },
    ];
}

describe("runCustomValidations date errors", () => {
    it("reports one error per column and kind of problem, with every offending line", async () => {
        const summary = await runCustomValidations(
            [row("6/29/2024"), row("2024-03-01"), row("1/2/2024"), row("2024-02-30")],
            "CPV",
            "2024",
            2
        ).toPromise();

        expect(summary.blockingErrors).toEqual([
            {
                error: 'Invalid date format in column "SAMPLE_DATE". Expected format: YYYY-MM-DD (e.g., 2024-09-23). Please update your file and re-upload.',
                count: 2,
                lines: [2, 4],
            },
            {
                error: 'Invalid date in column "SAMPLE_DATE": the date does not exist on the calendar. Please correct it and re-upload.',
                count: 1,
                lines: [5],
            },
        ]);
    });
});
