import { useEffect, useState } from "react";
import { useAppContext } from "../contexts/app-context";
import {
    AMCQuestionnaireOptionsContext,
    AMCQuestionnaireOptionsContextState,
    defaultAMCQuestionnaireOptionsContextState,
} from "../contexts/amc-questionnaire-options-context";
import { Future } from "../../domain/entities/Future";
import i18n from "@eyeseetea/d2-ui-components/locales";
import { useSnackbar } from "@eyeseetea/d2-ui-components";

export const AMCQuestionnaireOptionsContextProvider: React.FC = ({ children }) => {
    const { compositionRoot } = useAppContext();
    const snackbar = useSnackbar();
    const [amcQuestionnaireOptions, setAMCQuestionnaireOptions] = useState<AMCQuestionnaireOptionsContextState>(
        defaultAMCQuestionnaireOptionsContextState
    );

    useEffect(() => {
        return Future.joinObj({
            yesNoOptions: compositionRoot.amcQuestionnaires.getYesNoOptions(),
            yesNoUnknownOptions: compositionRoot.amcQuestionnaires.getYesNoUnknownOptions(),
            yesNoUnknownNAOptions: compositionRoot.amcQuestionnaires.getYesNoUnknownNAOptions(),
            antimicrobialClassOptions: compositionRoot.amcQuestionnaires.getAntimicrobialClassOptions(),
            proportion50to100UnknownOptions: compositionRoot.amcQuestionnaires.getProportion50to100UnknownOptions(),
            dataLevelOptions: compositionRoot.amcQuestionnaires.getDataLevelOptions(),
            dataSourceOptions: compositionRoot.amcQuestionnaires.getDataSourceOptions(),
            nationalPopulationDataSourceOptions:
                compositionRoot.amcQuestionnaires.getNationalPopulationDataSourceOptions(),
            procurementLevelOptions: compositionRoot.amcQuestionnaires.getProcurementLevelOptions(),
            strataOptions: compositionRoot.amcQuestionnaires.getStrataOptions(),
        }).run(
            options => {
                setAMCQuestionnaireOptions(options);
            },
            error => snackbar.error(`${i18n.t("Error fetching AMC questionnaire options")}: ${error}`)
        );
    }, [compositionRoot.amcQuestionnaires, snackbar]);

    return (
        <AMCQuestionnaireOptionsContext.Provider value={amcQuestionnaireOptions}>
            {children}
        </AMCQuestionnaireOptionsContext.Provider>
    );
};
