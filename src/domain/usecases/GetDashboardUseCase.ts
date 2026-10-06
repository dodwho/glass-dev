import { UseCase } from "../UseCase";
import { GlassModuleRepository } from "../repositories/GlassModuleRepository";
import { Future, FutureData } from "../entities/Future";

export class GetDashboardUseCase implements UseCase {
    constructor(private glassModuleDefaultRepository: GlassModuleRepository) {}

    public execute(moduleId: string): FutureData<{ reportDashboard: string; validationDashboard: string }> {
        return this.glassModuleDefaultRepository.getById(moduleId).flatMap(module => {
            return Future.success({
                reportDashboard: module.dashboards?.reportsMenu,
                validationDashboard: module.dashboards?.validationReport,
            });
        });
    }
}
