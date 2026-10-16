import { ExternalData } from "./ExternalData";

export interface RISData extends ExternalData {
    PATHOGEN: string;
    ANTIBIOTIC: string;
    RESISTANT: number;
    INTERMEDIATE: number;
    NONSUSCEPTIBLE: number;
    SUSCEPTIBLE: number;
    UNKNOWN_NO_AST: number;
    UNKNOWN_NO_BREAKPOINTS: number;
    ABCLASS: string;
}

export const RIS_RESULT_COLUMNS = [
    "RESISTANT",
    "INTERMEDIATE",
    "NONSUSCEPTIBLE",
    "SUSCEPTIBLE",
    "UNKNOWN_NO_AST",
    "UNKNOWN_NO_BREAKPOINTS",
] as const;
