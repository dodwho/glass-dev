import { FutureData } from "../entities/Future";

export interface EGASPProgramRepository {
    getTemplateSettings(): FutureData<any>;
}
