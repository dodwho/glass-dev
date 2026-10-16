import _ from "lodash";
import i18n from "../../../../locales";
import { ConsistencyError } from "../../../entities/data-entry/ImportSummary";
import { DataSetValidation } from "../../../entities/metadata/DataSetValidation";

export function checkDhis2Validations(
    validations: DataSetValidation[],
    rulesInstructions: { id: string; instruction: string }[]
): ConsistencyError[] {
    const messages = validations.flatMap(({ validationRuleViolations }) =>
        validationRuleViolations.map(rulesViolation =>
            i18n.t(
                `Validation rule '${(rulesViolation as any).validationRule.name}' violated. Left side value: '${
                    (rulesViolation as any).leftsideValue
                }', right side value: '${(rulesViolation as any).rightsideValue}'. Instructions: ${
                    rulesInstructions.find(instruction => instruction.id === (rulesViolation as any).validationRule.id)
                        ?.instruction || "-"
                }`
            )
        )
    );

    return Object.entries(_.countBy(messages)).map(([error, count]) => ({ error, count }));
}
