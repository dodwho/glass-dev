import { CustomDataColumns } from "../../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { checkSpecimenDateNotInFuture } from "../RISIndividualFungalFileValidations";

const now = new Date("2026-09-28T12:00:00Z");

function row(sampleDate: string): CustomDataColumns {
    return [{ key: "SAMPLE_DATE", type: "string", value: sampleDate }];
}

describe("checkSpecimenDateNotInFuture", () => {
    it("accepts past dates, today, and dates that are already today somewhere in the world", () => {
        expect(checkSpecimenDateNotInFuture(row("2026-01-01"), now)).toBeNull();
        expect(checkSpecimenDateNotInFuture(row("2026-09-28"), now)).toBeNull();
        expect(checkSpecimenDateNotInFuture(row("2026-09-29"), now)).toBeNull();
    });

    it("rejects dates that are in the future in every time zone", () => {
        expect(checkSpecimenDateNotInFuture(row("2026-09-30"), now)).toBe(
            "SAMPLE_DATE cannot be in the future: 2026-09-30"
        );
    });

    it("ignores empty or unparseable dates, which other checks report", () => {
        expect(checkSpecimenDateNotInFuture(row(""), now)).toBeNull();
        expect(checkSpecimenDateNotInFuture(row("30/09/2099"), now)).toBeNull();
    });
});
