import _ from "lodash";
import { CustomDataColumns } from "../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { ConsistencyError } from "../../../entities/data-entry/ImportSummary";

/** A tracked entity attribute or program stage data element, as returned by TrackerRepository.getProgramMetadata. */
export type ProgramFieldMetadata = {
    code: string;
    valueType: string;
    optionSetValue?: boolean;
    optionSet?: { options: { code: string }[] };
};

type ValueCheck = (value: string) => string | undefined;

// Laboratory software can export SDD (susceptible, dose-dependent), which is not part of the GLASS protocol.
// Said explicitly, so the country knows to recode the results rather than look for a typing mistake.
const SDD_NOT_ACCEPTED_HINT =
    "SDD (susceptible, dose-dependent) is not accepted by GLASS: report these results with one of the allowed codes, following the GLASS protocol, before uploading the file again";

/*
 * Mirrors the per-value checks DHIS2 applies when importing these rows, so bad values are reported up
 * front with their file lines instead of making DHIS2 reject a whole chunk. Measured against DHIS2 2.41
 * (importMode=VALIDATE): option codes must match exactly (case and spaces included, E1125) and
 * INTEGER_ZERO_OR_POSITIVE rejects decimals and negatives (E1302). Only values DHIS2 certainly rejects are
 * reported, so a file DHIS2 accepts is never blocked here. Dates are checked by runCustomValidations.
 */
function buildValueCheck(field: ProgramFieldMetadata): ValueCheck | undefined {
    const { code, valueType } = field;

    if (field.optionSetValue && field.optionSet) {
        const optionCodes = field.optionSet.options.map(option => option.code);
        const allowed = new Set(optionCodes);
        const allowedList = optionCodes.join(", ");
        return value => {
            if (allowed.has(value)) return undefined;
            const error = `${code}: "${value}" is not an allowed code (codes are case-sensitive). Allowed codes: ${allowedList}`;
            return value.trim().toUpperCase() === "SDD" ? `${error}. ${SDD_NOT_ACCEPTED_HINT}` : error;
        };
    }
    if (valueType === "INTEGER_ZERO_OR_POSITIVE") {
        return value =>
            /^\d+$/.test(String(Number(value)))
                ? undefined
                : `${code}: "${value}" must be a whole number of zero or more`;
    }
    if (valueType === "NUMBER") {
        return value => (Number.isFinite(Number(value)) ? undefined : `${code}: "${value}" is not a valid number`);
    }
    return undefined;
}

export function checkValuesAgainstProgramMetadata(
    rows: CustomDataColumns[],
    fields: ProgramFieldMetadata[],
    firstLine: number
): ConsistencyError[] {
    const checksByColumn = _(fields)
        .map(field => ({ column: field.code, check: buildValueCheck(field) }))
        .filter((entry): entry is { column: string; check: ValueCheck } => entry.check !== undefined)
        .groupBy(({ column }) => column)
        .mapValues(entries => entries.map(({ check }) => check))
        .value();

    const linesByError = new Map<string, number[]>();

    rows.forEach((row, index) => {
        const rowErrors = new Set<string>();
        row.forEach(({ key, value }) => {
            const checks = checksByColumn[key];
            const text = value === undefined || value === null ? "" : String(value);
            if (!checks || text.trim() === "") return;
            checks.forEach(check => {
                const error = check(text);
                if (error) rowErrors.add(error);
            });
        });
        rowErrors.forEach(error => {
            const lines = linesByError.get(error);
            if (lines) lines.push(firstLine + index);
            else linesByError.set(error, [firstLine + index]);
        });
    });

    return Array.from(linesByError, ([error, lines]) => ({ error, count: lines.length, lines }));
}
