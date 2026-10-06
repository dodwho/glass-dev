import { Id } from "../entities/Ref";
import { UseCase } from "../UseCase";
import { FutureData } from "../entities/Future";

import { Signal } from "../entities/Signal";

import { SignalRepository } from "../repositories/SignalRepository";

export class GetProgramQuestionnairesUseCase implements UseCase {
    constructor(private signalRepository: SignalRepository) {}

    public execute(currentOrgUnitId: Id): FutureData<Signal[]> {
        return this.signalRepository.getAll(currentOrgUnitId);
    }
}
