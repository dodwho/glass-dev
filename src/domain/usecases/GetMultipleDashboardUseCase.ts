import { UseCase } from "../UseCase";
import { GlassModuleRepository } from "../repositories/GlassModuleRepository";
import { Future, FutureData } from "../entities/Future";
import { NamedRef } from "../entities/Ref";

export class GetMultipleDashboardUseCase implements UseCase {
    constructor(private glassModuleDefaultRepository: GlassModuleRepository) {}

    public execute(
        moduleId: string
    ): FutureData<{ multiReportsMenu?: NamedRef[]; multiValidationReports?: NamedRef[] }> {
        return this.glassModuleDefaultRepository.getById(moduleId).flatMap(module => {
            return Future.success({
                multiReportsMenu: module.dashboards?.multiReportsMenu,
                multiValidationReports: module.dashboards?.multiValidationReports,
            });
        });
    }
}
