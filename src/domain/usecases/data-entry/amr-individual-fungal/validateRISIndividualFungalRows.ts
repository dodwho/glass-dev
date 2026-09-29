import { CustomDataColumns } from "../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { ConsistencyError, mergeConsistencyErrors } from "../../../entities/data-entry/ImportSummary";
import { FutureData } from "../../../entities/Future";
import { PATHOGEN_ANTIBIOTIC_MAP } from "../../../entities/GlassModule";
import { Id } from "../../../entities/Ref";
import { Maybe } from "../../../../utils/ts-utils";
import { checkSpecimenPathogenFromDataColumns } from "../utils/checkSpecimenPathogen";
import { checkFungalPathogenAntifungal } from "./checkFungalPathogenAntifungal";
import { checkValuesAgainstProgramMetadata, ProgramFieldMetadata } from "./checkValuesAgainstProgramMetadata";
import { runCustomValidations } from "./common";

export const AMR_FUNGAL_PROGRAM_STAGE_ID = "ysGSonDq9Bc";

export type RISIndividualFungalValidationContext = {
    countryCode: string;
    period: string;
    programStageId: Id;
    programMetadata: { programAttributes: ProgramFieldMetadata[]; programStageDataElements: ProgramFieldMetadata[] };
    specimenPathogen: Maybe<Record<string, PATHOGEN_ANTIBIOTIC_MAP[]>>;
};

/**
 * Every check a RIS individual/fungal file must pass before any of it is sent to DHIS2. Used by both the
 * in-browser upload and the async upload server so a file gets the same result whichever way it is imported.
 * Each row is checked on its own, so a file can be validated in chunks; `firstLine` is the file line of rows[0].
 */
export function validateRISIndividualFungalRows(
    rows: CustomDataColumns[],
    context: RISIndividualFungalValidationContext,
    firstLine: number
): FutureData<ConsistencyError[]> {
    const { countryCode, period, programStageId, programMetadata, specimenPathogen } = context;

    return runCustomValidations(rows, countryCode, period, firstLine).map(customValidation =>
        mergeConsistencyErrors(
            customValidation.blockingErrors,
            checkValuesAgainstProgramMetadata(
                rows,
                [...programMetadata.programAttributes, ...programMetadata.programStageDataElements],
                firstLine
            ),
            specimenPathogen ? checkSpecimenPathogenFromDataColumns(rows, specimenPathogen, firstLine) : [],
            programStageId === AMR_FUNGAL_PROGRAM_STAGE_ID ? checkFungalPathogenAntifungal(rows, firstLine) : []
        )
    );
}
