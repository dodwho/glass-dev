import { ExternalData } from "./ExternalData";

export interface RISData extends ExternalData {
    PATHOGEN: string;
    ANTIBIOTIC: string;
    // AST results: null is a blank cell.
    RESISTANT: number | null;
    INTERMEDIATE: number | null;
    NONSUSCEPTIBLE: number | null;
    SUSCEPTIBLE: number | null;
    UNKNOWN_NO_AST: number | null;
    UNKNOWN_NO_BREAKPOINTS: number | null;
    ABCLASS: string;
}

/**
 * The text sent to DHIS2 for a cell of an AMR aggregate file. A blank AST result is stored as 0 until the
 * epidemiologists decide column by column (review decision D1); a row with all six blank is blocked by checkASTResults.
 */
export function toAMRAggDataValue(value: string | number | null | undefined): string {
    return value === null ? "0" : value?.toString() || "";
}

export const RIS_RESULT_COLUMNS = [
    "RESISTANT",
    "INTERMEDIATE",
    "NONSUSCEPTIBLE",
    "SUSCEPTIBLE",
    "UNKNOWN_NO_AST",
    "UNKNOWN_NO_BREAKPOINTS",
] as const;
