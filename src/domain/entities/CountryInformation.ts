import { GlassModuleName, MODULE_NAMES } from "./GlassModule";

/**
 * Tracker program "AMR - Focal Point": the source of truth for which modules a country is enrolled in.
 *
 * One tracked entity per (country org unit, module), carrying the module in ENROLMENT_MODULE_ATTRIBUTE_ID.
 * A module is shown for a country iff such a tracked entity exists with an enrollment — see
 * GetGlassModulesUseCase. The enrollment *status* is never checked, so cancelling an enrollment does not
 * hide the module; only deleting the tracked entity does.
 */
export const ENROLMENT_PROGRAM_ID = "oo0bqS0AqMI";

/** TEI attribute AMR_MODULE, bound to option set "Module" (LlYtLIsSR29). */
export const ENROLMENT_MODULE_ATTRIBUTE_ID = "Fh6atHPjdxC";

/**
 * The value stored in ENROLMENT_MODULE_ATTRIBUTE_ID for each module: the code of its option in the
 * "Module" option set, which is what every existing enrolment holds.
 */
export const MODULE_ENROLMENT_CODES: Record<GlassModuleName, string> = {
    [MODULE_NAMES.AMR]: "AMR",
    [MODULE_NAMES.AMR_INDIVIDUAL]: "AMR_INDIVIDUAL",
    [MODULE_NAMES.AMR_FUNGAL]: "AMR_FUNGAL",
    [MODULE_NAMES.AMC]: "AMC",
    [MODULE_NAMES.EGASP]: "EGASP",
    [MODULE_NAMES.EAR]: "EAR",
};

export interface CountryInformation {
    module: string;
    WHORegion: string;
    country: string;
    year: number;
    enrolmentStatus: string;
    enrolmentDate: string;
    nationalFocalPointId?: string;
    nationalFocalPoints: NationalFocalPoint[];
}

export interface NationalFocalPoint {
    id: string;
    values: NationalFocalPointValue[];
}

export interface NationalFocalPointValue {
    id: string;
    name: string;
    value: string | number | boolean;
}
