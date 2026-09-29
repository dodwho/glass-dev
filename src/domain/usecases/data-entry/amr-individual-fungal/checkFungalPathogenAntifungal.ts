import { CustomDataColumns } from "../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { ConsistencyError } from "../../../entities/data-entry/ImportSummary";

/*
 * Same check as the DHIS2 program rules "AMR - Pathogen/AntiFungal wrong combination RESULT{ETEST,MIC,ZONE}SIR"
 * on the "AMR - Fungi" stage, which the rule engine used to evaluate. A row that has an antifungal result
 * must respect the two lists below. Codes are case-sensitive, as in the rules.
 */

export const FUNGAL_COMBINATION_ERROR = "This combination of Pathogen/AntiFungal is not allowed";

const RESULT_COLUMNS = ["RESULTETESTSIR", "RESULTMICSIR", "RESULTZONESIR"];

/** Pathogens that must never have an antifungal result. */
// prettier-ignore
const PATHOGENS_WITHOUT_ANTIFUNGAL_RESULTS = new Set([
    "ACISPP", "ESCCOL", "HAEINF", "KLEPNE", "NEIGON", "NEIMEN", "PSEAER", "SALSPP", "SALPAR", "SALTYP",
    "SHISPP", "STAAUR", "STRPNE", "crs", "cct", "cci", "cdh", "tca", "tha", "tin", "cin", "clm", "clp",
    "cru", "sak", "can", "csl", "ctn", "cut", "cvn", "cvw", "cze", "cxa", "cax", "cfb", "cfn", "cgo",
    "cgx", "chu", "cmn", "cnr", "col", "cpx", "crp", "cta", "cth", "cui", "kii", "mio", "ths", "thx",
    "yzb", "yzh", "kma",
]);

/** Pathogens whose antifungal results are only allowed for these antifungals. */
const ALLOWED_ANTIFUNGALS_BY_PATHOGEN: Record<string, string[]> = {
    cal: ["ANI", "CAS", "FLU", "MIF", "VOR", "AMB", "POS", "ITR"],
    cgl: ["ANI", "CAS", "FLU", "MIF", "VOR", "AMB"],
    cgu: ["ANI", "CAS", "MIF"],
    ckr: ["ANI", "CAS", "FLU", "MIF", "VOR", "AMB"],
    cpa: ["ANI", "CAS", "FLU", "MIF", "VOR", "AMB", "POS", "ITR"],
    ctr: ["ANI", "CAS", "FLU", "MIF", "VOR", "AMB", "POS", "ITR"],
    cdu: ["FLU", "AMB", "POS", "VOR", "ITR"],
};

// Same "has a value" test as the rule engine (VariableService.buildVariable).
function hasValue(value: unknown): boolean {
    return !!value || value === 0 || value === false;
}

function isNotAllowed(row: CustomDataColumns): boolean {
    const valueOf = (column: string) => row.find(item => item.key === column)?.value;
    if (!RESULT_COLUMNS.some(column => hasValue(valueOf(column)))) return false;

    const pathogen = valueOf("PATHOGEN");
    const antifungal = valueOf("ANTIBIOTIC");
    if (typeof pathogen !== "string") return false;
    if (PATHOGENS_WITHOUT_ANTIFUNGAL_RESULTS.has(pathogen)) return true;

    const allowedAntifungals = ALLOWED_ANTIFUNGALS_BY_PATHOGEN[pathogen];
    return !!allowedAntifungals && hasValue(antifungal) && !allowedAntifungals.includes(String(antifungal));
}

export function checkFungalPathogenAntifungal(rows: CustomDataColumns[], firstLine: number): ConsistencyError[] {
    const lines = rows.flatMap((row, index) => (isNotAllowed(row) ? [firstLine + index] : []));
    return lines.length > 0 ? [{ error: FUNGAL_COMBINATION_ERROR, count: lines.length, lines }] : [];
}
