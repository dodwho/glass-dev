import { GlassModuleName, MODULE_NAMES } from "./GlassModule";

export { ENROLMENT_PROGRAM_ID, ENROLMENT_MODULE_ATTRIBUTE_ID } from "./GlassMetadataReferences";

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
