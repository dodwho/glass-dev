import { EventsRepository } from "../repositories/EventsRepository";
import { Id } from "../entities/Base";
import { GlassModule } from "../entities/GlassModule";
import { QuestionnaireRepository } from "../repositories/QuestionnaireRepository";
import { GetAMCQuestionnaireListUseCase } from "./GetAMCQuestionnaireListUseCase";

export class GetQuestionnaireListUseCase {
    constructor(
        private questionnaireRepository: QuestionnaireRepository,
        private dhis2EventsDefaultRepository: EventsRepository
    ) {}

    execute(module: GlassModule, options: { orgUnitId: Id; year: string }, captureAccess: boolean) {
        if (module.questionnairesType === "Dataset")
            return this.questionnaireRepository.getDatasetList(module, options, captureAccess);
        else {
            const AMCQuestionnaireSplitHandler = new GetAMCQuestionnaireListUseCase(
                this.questionnaireRepository,
                this.dhis2EventsDefaultRepository
            );
            return AMCQuestionnaireSplitHandler.getQuestionnaires(module, options);
        }
    }
}
