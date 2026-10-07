import _ from "lodash";
import { Question, Questionnaire } from "../entities/Questionnaire";
import { Id, NamedRef } from "../entities/Ref";
import { AMC_SECTOR_LEVEL_QUESTION_IDS } from "../entities/GlassMetadataReferences";

interface AMCQuestionDisableMap {
    id: Id;
    name: string;
    questionsToDisable: Id[];
}

//Community sector levels
const sl_pub_com = AMC_SECTOR_LEVEL_QUESTION_IDS.communityPublic;
const sl_pri_com = AMC_SECTOR_LEVEL_QUESTION_IDS.communityPrivate;
const sl_glo_com = AMC_SECTOR_LEVEL_QUESTION_IDS.communityGlobal;
//Hospital sector levels
const sl_pub_hos = AMC_SECTOR_LEVEL_QUESTION_IDS.hospitalPublic;
const sl_pri_hos = AMC_SECTOR_LEVEL_QUESTION_IDS.hospitalPrivate;
const sl_glo_hos = AMC_SECTOR_LEVEL_QUESTION_IDS.hospitalGlobal;
//Total sector levels
const sl_glo_pub = AMC_SECTOR_LEVEL_QUESTION_IDS.totalPublic;
const sl_glo_pri = AMC_SECTOR_LEVEL_QUESTION_IDS.totalPrivate;
const sl_glo_tot = AMC_SECTOR_LEVEL_QUESTION_IDS.totalGlobal;

export const amcQuestionMap: AMCQuestionDisableMap[] = [
    //Community sector levels
    {
        id: sl_pub_com,
        name: "Community level & Public sector",
        questionsToDisable: [sl_glo_com, sl_glo_pub, sl_glo_tot],
    },
    {
        id: sl_pri_com,
        name: "Community level & Private sector",
        questionsToDisable: [sl_glo_com, sl_glo_pri, sl_glo_tot],
    },
    {
        id: sl_glo_com,
        name: "Community level & Global sector",
        questionsToDisable: [sl_pub_com, sl_pri_com, sl_glo_tot, sl_glo_pub, sl_glo_pri],
    },
    //Hospital sector levels
    {
        id: sl_pub_hos,
        name: "Hospital level & Public sector",
        questionsToDisable: [sl_glo_hos, sl_glo_pub, sl_glo_tot],
    },
    {
        id: sl_pri_hos,
        name: "Hospital level & Private sector",
        questionsToDisable: [sl_glo_hos, sl_glo_pri, sl_glo_tot],
    },
    {
        id: sl_glo_hos,
        name: "Hospital level & Global sector",
        questionsToDisable: [sl_pub_hos, sl_pri_hos, sl_glo_tot, sl_glo_pub, sl_glo_pri],
    },
    //Total sector levels
    {
        id: sl_glo_pub,
        name: "Total level & Public sector",
        questionsToDisable: [sl_glo_tot, sl_pub_com, sl_pub_hos],
    },
    {
        id: sl_glo_pri,
        name: "Total level & Private sector",
        questionsToDisable: [sl_glo_tot, sl_pri_com, sl_pri_hos],
    },
    {
        id: sl_glo_tot,
        name: "Total level & Global sector",
        questionsToDisable: [
            sl_glo_pub,
            sl_glo_pri,
            sl_pub_com,
            sl_pri_com,
            sl_glo_com,
            sl_pub_hos,
            sl_pri_hos,
            sl_glo_hos,
        ],
    },
];

export class ApplyAMCQuestionUpdationUseCase {
    public execute(
        moduleName: string,
        question: Question,
        questionnaire: Questionnaire,
        selectedSubQuestionnaires?: NamedRef[]
    ): { updatedQuestionnaire: Questionnaire; updatedAggSubQuestionnaires: NamedRef[] | undefined } {
        //update question in questionnaire
        const sectionToBeUpdated = questionnaire?.sections.filter(sec =>
            sec.questions.find(q => q.id === question?.id)
        );
        if (sectionToBeUpdated) {
            const questionToBeUpdated = sectionToBeUpdated[0]?.questions.filter(q => q.id === question.id);
            if (questionToBeUpdated && questionToBeUpdated[0]) questionToBeUpdated[0].value = question.value;

            const mappedQuestionUpdated = amcQuestionMap.find(qm => qm.id === question.id);
            //For AMC Questionnaire, apply intra Questionnaire validation logic.
            //If the Question is one of the level and sector selectors
            if (mappedQuestionUpdated) {
                //For the currently updated question, enable/disable corresponding questions based on value.
                const currentQuestionUpdates = amcQuestionMap.filter(qm => qm.id === question.id)[0]
                    ?.questionsToDisable;
                currentQuestionUpdates?.map(cqm => {
                    const dependentQuestionToUpdate = _(
                        questionnaire.sections.map(qs => qs.questions.find(q => q.id === cqm))
                    )
                        .compact()
                        .value();
                    if (
                        dependentQuestionToUpdate &&
                        dependentQuestionToUpdate[0] &&
                        dependentQuestionToUpdate[0].type === "singleCheck"
                    ) {
                        dependentQuestionToUpdate[0].disabled = question.value ? true : false;
                    } else {
                        console.debug("An error occured, there should be a corresponding question");
                    }
                });

                //There could be other question that were checked earlier,
                //which correspond to same question which was uodated above
                //re-calculate all the other question's disable status
                const questionsToDisable = questionnaire.sections.flatMap(s => {
                    const enabledSubQuestionnaireQs = s.questions.filter(
                        eq => eq.value === true && amcQuestionMap.some(qm => qm.id === eq.id)
                    );
                    if (selectedSubQuestionnaires && selectedSubQuestionnaires.length > 0) {
                        const updatedSelectedSubQuestionnaires = selectedSubQuestionnaires?.filter(
                            sq => sq.id !== questionToBeUpdated?.[0]?.id
                        );
                        enabledSubQuestionnaireQs.push(
                            ...s.questions.filter(q => updatedSelectedSubQuestionnaires?.some(sq => sq.id === q.id))
                        );
                    }

                    const subQuestionnaireQsToDisable = _(
                        enabledSubQuestionnaireQs.flatMap(
                            enQ => amcQuestionMap.find(enQm => enQm.id === enQ.id)?.questionsToDisable
                        )
                    )
                        .compact()
                        .value();

                    return subQuestionnaireQsToDisable;
                });

                questionsToDisable.map(qd => {
                    const questionToUpdate = _(questionnaire.sections.map(qs => qs.questions.find(q => q.id === qd)))
                        .compact()
                        .value();

                    if (questionToUpdate && questionToUpdate[0] && questionToUpdate[0].type === "singleCheck") {
                        questionToUpdate[0].disabled = true;
                    } else {
                        console.debug("An error occured, there should be a corresponding question");
                    }
                });
            }
        }
        if (question.value === false && selectedSubQuestionnaires?.find(sq => sq.id === question.id)) {
            const updatedAggSubQuestionnaires = selectedSubQuestionnaires.filter(sq => sq.id !== question.id);
            return { updatedQuestionnaire: questionnaire, updatedAggSubQuestionnaires: updatedAggSubQuestionnaires };
        }
        return { updatedQuestionnaire: questionnaire, updatedAggSubQuestionnaires: selectedSubQuestionnaires };
    }
}
