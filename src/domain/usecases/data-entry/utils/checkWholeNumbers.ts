import i18n from "../../../../locales";
import { ConsistencyError } from "../../../entities/data-entry/ImportSummary";
import { groupLineErrors } from "./groupLineErrors";

/**
 * DHIS2 keeps these counts only as whole numbers 0 or higher (INTEGER_ZERO_OR_POSITIVE) and ignores any other value,
 * after the rest of the file is saved; reported here before import instead. A blank cell (null) is left to other checks.
 */
export function checkWholeNumbers<Row>(rows: Row[], columns: Array<keyof Row & string>): ConsistencyError[] {
    return groupLineErrors(
        rows.flatMap((row, index) =>
            columns
                .filter(column => {
                    const value = row[column];
                    return value !== null && !(typeof value === "number" && Number.isInteger(value) && value >= 0);
                })
                .map(column => ({
                    error: i18n.t("{{column}} must be a whole number 0 or higher, such as 0, 25 or 1,234", { column }),
                    line: index + 1,
                }))
        )
    );
}
