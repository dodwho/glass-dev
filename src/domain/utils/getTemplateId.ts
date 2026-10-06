import { Id } from "../entities/Ref";
import {
    AMC_CALCULATED_CONSUMPTION_DATA_PROGRAM_ID as AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID,
    AMC_PRODUCT_REGISTER_PROGRAM_ID,
    AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
    EGASP_PROGRAM_ID,
} from "../entities/GlassMetadataReferences";

export const getTemplateId = (programId: Id): string => {
    switch (programId) {
        case AMC_PRODUCT_REGISTER_PROGRAM_ID:
            return "TRACKER_PROGRAM_GENERATED_v3";
        case EGASP_PROGRAM_ID:
        case AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID:
        case AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID:
            return "PROGRAM_GENERATED_v4";
        default:
            return "";
    }
};
