import { UseCase } from "../UseCase";
import { SystemInfoRepository } from "../repositories/SystemInfoRepository";
import { FutureData } from "../entities/Future";

export class GetLastAnalyticsRunTimeUseCase implements UseCase {
    constructor(private systemInfoDefaultRepository: SystemInfoRepository) {}

    public execute(): FutureData<Date> {
        return this.systemInfoDefaultRepository.getLastAnalyticsRunTime();
    }
}
