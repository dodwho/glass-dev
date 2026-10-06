import { Id } from "./Ref";

/**
 * The DHIS2 metadata ids the domain layer refers to, in one place.
 *
 * These used to be redeclared across many use cases, often under different names for the same DHIS2
 * object. Duplicated literals drift: one copy gets updated for a metadata change and the others silently
 * do not. Import from here instead of redeclaring or inlining an id.
 *
 * This module has no dependencies besides a type, so node scripts can reach it without pulling in the
 * use cases (and their validation/i18n dependency tree). Older modules re-export the constants they used
 * to declare, so existing import sites keep working.
 *
 * Groups: shared / GLASS modules / enrolment / AMR aggregate (RIS, SAMPLE) / AMR individual and fungal /
 * AMC product and substance / AMC questionnaires / EGASP / EAR (signals).
 *
 * Scope: the domain and webapp layers. Ids owned by the DHIS2 adapter (src/data) stay in the data layer,
 * and the maintenance scripts in src/scripts still declare their own copies (to be switched over).
 */

// --- Shared --------------------------------------------------------------------------------------

/** The DHIS2 default category combination. */
export const DEFAULT_CATEGORY_COMBO_ID: Id = "bjDvmb4bfuf";

/**
 * Data element carrying the ATC version of an event. Read by the EGASP custom validation and by the
 * event-program (BL template) import.
 */
export const ATC_VERSION_DATA_ELEMENT_ID: Id = "aCuWz3HZ5Ti";

// --- GLASS modules -------------------------------------------------------------------------------

/** Ids of the GLASS modules, as stored in the module list (GlassModule.id). */
export const AMR_MODULE_ID: Id = "AVnpk4xiXGG";
export const AMR_INDIVIDUAL_MODULE_ID: Id = "IVnpk5xiXGG";
export const AMC_MODULE_ID: Id = "BVnik5xiXGJ";
export const EGASP_MODULE_ID: Id = "CVVp44xiXGJ";

// --- Enrolment -----------------------------------------------------------------------------------

/**
 * Tracker program "AMR - Focal Point": the source of truth for which modules a country is enrolled in.
 *
 * One tracked entity per (country org unit, module), carrying the module in ENROLMENT_MODULE_ATTRIBUTE_ID.
 * A module is shown for a country only while such a tracked entity has an ACTIVE enrollment — see
 * GetGlassModulesUseCase. Un-enrol by CANCELLING the enrollment, never by deleting the tracked entity:
 * deleting it also deletes the country's focal-point contacts.
 */
export const ENROLMENT_PROGRAM_ID: Id = "oo0bqS0AqMI";

/** TEI attribute AMR_MODULE, bound to option set "Module" (LlYtLIsSR29). */
export const ENROLMENT_MODULE_ATTRIBUTE_ID: Id = "Fh6atHPjdxC";

// --- AMR aggregate (RIS, SAMPLE) -----------------------------------------------------------------

/** Data set "AMR - AMR DS Input files RIS DS" — the target of a RIS file upload. */
export const AMR_AMR_DS_INPUT_FILES_RIS_DS_ID: Id = "CeQPmXgrhHF";

/** Category combination PATHOGEN / ANTIBIOTIC / BATCHIDDS — the RIS data set's attribute dimensions. */
export const AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID: Id = "S427AvQESbw";

/** Data set "AMR - AMR DS Input files Sample DS" — the target of a SAMPLE file upload. */
export const AMR_AMR_DS_Input_files_Sample_DS_ID: Id = "OcAB7oaC072";

/** Category combination BATCHIDDS — the SAMPLE data set's attribute dimension. */
export const AMR_BATCHID_CC_ID: Id = "rEMx3WFeLcU";

/** Category combination SPECIMEN / GENDER / ORIGIN / AGEGROUP — the data elements' disaggregation. */
export const AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID: Id = "OwKsZQnHCJu";

// --- AMR individual and fungal -------------------------------------------------------------------

/** Tracker program of the AMR Individual and AMR Fungal modules (default when none is configured). */
export const AMR_INDIVIDUAL_PROGRAM_ID: Id = "mMAj6Gofe49";

/** Stage holding the AMR Individual data. */
export const AMR_DATA_PROGRAM_STAGE_ID: Id = "KCmWZD8qoAk";

/** Stage holding the AMR Fungal data. */
export const AMR_FUNGAL_PROGRAM_STAGE_ID: Id = "ysGSonDq9Bc";

/** Tracked entity type: patient. */
export const AMR_GLASS_AMR_TET_PATIENT: Id = "CcgnfemKr5U";

/** Data element: sample date. */
export const AMR_GLASS_AMR_DET_SAMPLE_DATE: Id = "Xtn5zEL9mGx";

/** Patient tracked entity attributes that are mandatory (column PATIENTCOUNTER / PATIENT_ID). */
export const AMR_PATIENT_COUNTER_TEA_ID: Id = "uSGcLbT5gJJ";
export const AMR_PATIENT_ID_TEA_ID: Id = "qKWPfeSgTnc";

// --- AMC product and substance -------------------------------------------------------------------

/** Tracker program: AMC Product Register. */
export const AMC_PRODUCT_REGISTER_PROGRAM_ID: Id = "G6ChA5zMW9n";

/** Tracked entity type: AMC product register entry. */
export const AMR_GLASS_AMC_TET_PRODUCT_REGISTER: Id = "uE6bIKLsGYW";

/** Stage holding the product consumption a country reported. */
export const AMC_RAW_PRODUCT_CONSUMPTION_STAGE_ID: Id = "GmElQHKXLIE";

/**
 * Stage holding the substance consumption derived from product consumption. Named after what it
 * contains (substances), inside the product register program.
 */
export const AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID: Id = "q8cl5qllyjd";

/** Event program: substance consumption a country reported directly. */
export const AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID: Id = "q8aSKr17J5S";

export const AMC_RAW_SUBSTANCE_CONSUMPTION_DATA_PROGRAM_STAGE_ID: Id = "GuGDhDZUSBX";

/**
 * Event program: calculated consumption. Written by BOTH pipelines — the product-level calculation
 * aggregates into it, and so does the substance-level calculation.
 */
export const AMC_CALCULATED_CONSUMPTION_DATA_PROGRAM_ID: Id = "eUmWZeKZNrg";

export const AMC_CALCULATED_CONSUMPTION_DATA_PROGRAM_STAGE_ID: Id = "ekEXxadjL0e";

/** Product register tracked entity attributes. */
export const AMR_GLASS_AMC_TEA_PRODUCT_ID: Id = "iasfoeU8veF";
export const AMR_GLASS_AMC_TEA_ATC: Id = "aK1JpD14imM";
export const AMR_GLASS_AMC_TEA_COMBINATION: Id = "mG49egdYK3G";
export const AMR_GLASS_AMC_TEA_ROUTE_ADMIN: Id = "m4eyu3tO5IV";
export const AMR_GLASS_AMC_TEA_SALT: Id = "K8wjLXjYFzf";
export const AMR_GLASS_AMC_TEA_MANUFACTURER_COUNTRY: Id = "OCSAMKIi1BD";

// --- AMC questionnaires --------------------------------------------------------------------------

/** Event program: AMC data questionnaire. */
export const AMC_QUESTIONNAIRE_PROGRAM_ID: Id = "qGG6BjULAaf";

/** Stage of the AMC data questionnaire program. */
export const AMC_QUESTIONNAIRE_PROGRAM_STAGE: Id = "eks1YEESEOK";

/** Data element holding the period (year) of an AMC data questionnaire event. */
export const AMR_GLASS_AMC_DET_DS_PERIOD: Id = "W4D5kpe1il2";

/**
 * AMC questionnaire questions for each (level, sector) combination, where the level is community,
 * hospital or total and the sector is public, private or global. Used to disable the questions that
 * overlap with the one being answered.
 */
export const AMC_SECTOR_LEVEL_QUESTION_IDS = {
    communityPublic: "OyEpE54Ni9M",
    communityPrivate: "iEiUvYuiZ67",
    communityGlobal: "q0I3VtGouPX",
    hospitalPublic: "uIeCXoTa56d",
    hospitalPrivate: "Owcxj6ieun0",
    hospitalGlobal: "u2YDekmc8YR",
    totalPublic: "mQS6OUXAaRr",
    totalPrivate: "GWac7iDfHv3",
    totalGlobal: "mks6wWdSZRq",
} as const;

// --- EGASP ---------------------------------------------------------------------------------------

/** Event program: EGASP. */
export const EGASP_PROGRAM_ID: Id = "SOjanrinfuG";

/** EGASP data elements read by the custom validation. */
export const EGASP_DATAELEMENT_ID: Id = "KaS2YBRN8eH";
export const PATIENT_DATAELEMENT_ID: Id = "aocFHBxcQa0";

// --- EAR (signals) -------------------------------------------------------------------------------

/** Event program: EAR signals, and its stage. */
export const EAR_PROGRAM_ID: Id = "SQe26z0smFP";
export const EAR_PROGRAM_STAGE_ID: Id = "Oic1c7maX1g";

/** Data element marking a signal as confidential. */
export const EAR_CONFIDENTIAL_DATAELEMENT: Id = "KycX5z7NLqU";
