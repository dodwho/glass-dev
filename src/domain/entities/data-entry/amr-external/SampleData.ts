import { ExternalData } from "./ExternalData";

export interface SampleData extends ExternalData {
    NUMINFECTED: number;
    NUMSAMPLEDPATIENTS: number;
}

export const SAMPLE_COUNT_COLUMNS = ["NUMINFECTED", "NUMSAMPLEDPATIENTS"] as const;
