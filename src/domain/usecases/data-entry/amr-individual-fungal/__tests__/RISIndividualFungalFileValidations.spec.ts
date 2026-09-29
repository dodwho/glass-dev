import { CustomDataColumns } from "../../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { MANDATORY_TEI_ATTRIBUTES, checkMandatoryAttribute } from "../RISIndividualFungalFileValidations";

function row(patientCounter: unknown, patientId?: unknown): CustomDataColumns {
    return [
        { key: "PATIENTCOUNTER", type: "number", value: patientCounter },
        { key: "PATIENT_ID", type: "string", value: patientId },
    ] as CustomDataColumns;
}

describe("MANDATORY_TEI_ATTRIBUTES", () => {
    it("lists the attributes DHIS2 marks mandatory on tracked entity type CcgnfemKr5U", () => {
        expect(MANDATORY_TEI_ATTRIBUTES).toEqual([
            { id: "uSGcLbT5gJJ", column: "PATIENTCOUNTER" },
            { id: "qKWPfeSgTnc", column: "PATIENT_ID" },
        ]);
    });
});

describe("checkMandatoryAttribute", () => {
    it("accepts a populated value", () => {
        expect(checkMandatoryAttribute(row(12), "PATIENTCOUNTER")).toBeNull();
        expect(checkMandatoryAttribute(row(12, "P-1"), "PATIENT_ID")).toBeNull();
    });

    it("accepts zero, which DHIS2 treats as a value and not as null", () => {
        expect(checkMandatoryAttribute(row(0), "PATIENTCOUNTER")).toBeNull();
    });

    // A blank or non-numeric PATIENTCOUNTER cell reaches here as undefined (see toNumberOrUndefined),
    // and would otherwise be sent as "" and rejected server-side with E1076.
    it("rejects a numeric column that is blank or did not parse as a number", () => {
        expect(checkMandatoryAttribute(row(undefined), "PATIENTCOUNTER")).toBe(
            "PATIENTCOUNTER is mandatory: the value is empty or not a valid number"
        );
    });

    it("rejects a blank or whitespace-only text column", () => {
        expect(checkMandatoryAttribute(row(12, ""), "PATIENT_ID")).toBe("PATIENT_ID is mandatory and cannot be empty");
        expect(checkMandatoryAttribute(row(12, "   "), "PATIENT_ID")).toBe(
            "PATIENT_ID is mandatory and cannot be empty"
        );
    });

    it("rejects a column that is absent from the file altogether", () => {
        expect(checkMandatoryAttribute([], "PATIENTCOUNTER")).toBe("PATIENTCOUNTER is mandatory and cannot be empty");
    });
});
