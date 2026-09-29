// DHIS2 ids of the AMR module's AGGREGATE data entry metadata, kept in a dependency-free module so
// that node scripts can reach them without pulling in the import use cases (and their whole
// validation/i18n dependency tree). ImportRISFile.ts / ImportSampleFile.ts re-export them, so every
// existing import site keeps working.

/** Data set "AMR - AMR DS Input files RIS DS" — the target of a RIS file upload. */
export const AMR_AMR_DS_INPUT_FILES_RIS_DS_ID = "CeQPmXgrhHF";

/** Category combination PATHOGEN / ANTIBIOTIC / BATCHIDDS — the RIS data set's attribute dimensions. */
export const AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID = "S427AvQESbw";

/** Data set "AMR - AMR DS Input files Sample DS" — the target of a SAMPLE file upload. */
export const AMR_AMR_DS_Input_files_Sample_DS_ID = "OcAB7oaC072";

/** Category combination BATCHIDDS — the SAMPLE data set's attribute dimension. */
export const AMR_BATCHID_CC_ID = "rEMx3WFeLcU";
