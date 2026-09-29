import { Id } from "../../Ref";

/**
 * The DHIS2 metadata ids of the AMC module, in one place.
 *
 * These were previously redeclared in seven files, and the same DHIS2 object carried different names
 * in different ones — stage `q8cl5qllyjd` was both `AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID`
 * and `AMC_RAW_PRODUCT_CONSUMPTION_CALCULATED_STAGE_ID`, and program `eUmWZeKZNrg` had three names.
 * Duplicated literals drift: one copy gets updated for a metadata change and the others silently do
 * not. Import from here instead of redeclaring.
 */

// --- Product level -------------------------------------------------------------------------------

/** Tracker program: AMC Product Register. */
export const AMC_PRODUCT_REGISTER_PROGRAM_ID: Id = "G6ChA5zMW9n";

/** Stage holding the product consumption a country reported. */
export const AMC_RAW_PRODUCT_CONSUMPTION_STAGE_ID: Id = "GmElQHKXLIE";

/**
 * Stage holding the substance consumption derived from product consumption. Named after what it
 * contains (substances), inside the product register program.
 */
export const AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID: Id = "q8cl5qllyjd";

// --- Substance level -----------------------------------------------------------------------------

/** Event program: substance consumption a country reported directly. */
export const AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID: Id = "q8aSKr17J5S";

export const AMC_RAW_SUBSTANCE_CONSUMPTION_DATA_PROGRAM_STAGE_ID: Id = "GuGDhDZUSBX";

/**
 * Event program: calculated consumption. Written by BOTH pipelines — the product-level calculation
 * aggregates into it, and so does the substance-level calculation.
 */
export const AMC_CALCULATED_CONSUMPTION_DATA_PROGRAM_ID: Id = "eUmWZeKZNrg";

export const AMC_CALCULATED_CONSUMPTION_DATA_PROGRAM_STAGE_ID: Id = "ekEXxadjL0e";

// --- Product register tracked entity attributes --------------------------------------------------

export const AMR_GLASS_AMC_TEA_PRODUCT_ID: Id = "iasfoeU8veF";
export const AMR_GLASS_AMC_TEA_ATC: Id = "aK1JpD14imM";
export const AMR_GLASS_AMC_TEA_COMBINATION: Id = "mG49egdYK3G";
export const AMR_GLASS_AMC_TEA_ROUTE_ADMIN: Id = "m4eyu3tO5IV";
export const AMR_GLASS_AMC_TEA_SALT: Id = "K8wjLXjYFzf";
export const AMR_GLASS_AMC_TEA_MANUFACTURER_COUNTRY: Id = "OCSAMKIi1BD";

// --- GLASS module --------------------------------------------------------------------------------

export const AMC_MODULE_ID: Id = "BVnik5xiXGJ";
