import { DataValue } from "../../../entities/data-entry/DataValue";
import { ConsistencyError } from "../../../entities/data-entry/ImportSummary";
import { CategoryCombo } from "../../../entities/metadata/CategoryCombo";

const isBatchCode = (code: string) => /^DS\d+$/.test(code);

/** Empty and zero results carry no information of their own (DHIS2 may not store zeros): left out of a row. */
const isInformative = (value: string) => value !== "" && value !== "0";

/**
 * File rows already stored for the same country and year. India 2024 RIS DS2 repeated DS1, and the UK 2024 UKHSA
 * file was stored under DS2 and DS3, so the data was counted twice. A row is the same when every result in it is
 * (zeros and empty results left out, so a row of only zeros is never compared). A file whose every row is already
 * stored under one other dataset is blocked; any row already stored, under any dataset, gives a warning with its lines.
 * `fileRows` holds the data values of each file line, in file order.
 */
export function checkCopiedBatch(
    fileRows: DataValue[][],
    storedValues: DataValue[],
    dataSet_CC: CategoryCombo,
    batchId: string
): { blockingErrors: ConsistencyError[]; warnings: ConsistencyError[] } {
    const combos = new Map(
        dataSet_CC.categoryOptionCombos.map(combo => {
            const batch = combo.categoryOptions.find(option => isBatchCode(option.code))?.code ?? "";
            const rest = combo.categoryOptions
                .filter(option => !isBatchCode(option.code))
                .map(option => option.id)
                .sort()
                .join("+");
            return [combo.id, { batch, rest }];
        })
    );
    // Only data elements disaggregated by the row's demography make up a row: they share its category option combo.
    const rowDataElements = new Set(
        fileRows.flat().flatMap(value => (value.categoryOptionCombo ? [value.dataElement] : []))
    );
    const signature = (values: DataValue[]) => {
        const first = values[0];
        const combo = combos.get(first?.attributeOptionCombo ?? "");
        const results = values
            .filter(value => rowDataElements.has(value.dataElement) && isInformative(value.value))
            .map(value => `${value.dataElement}=${value.value}`)
            .sort();
        return combo && first && results.length > 0
            ? { batch: combo.batch, key: `${first.categoryOptionCombo}|${combo.rest}|${results.join(",")}` }
            : undefined;
    };

    const storedRows = new Map<string, DataValue[]>();
    for (const value of storedValues) {
        if (!rowDataElements.has(value.dataElement)) continue;
        const cell = `${value.attributeOptionCombo}|${value.categoryOptionCombo}`;
        storedRows.set(cell, [...(storedRows.get(cell) ?? []), value]);
    }
    const batchesByRow = new Map<string, Set<string>>();
    for (const values of storedRows.values()) {
        const row = signature(values);
        if (row) batchesByRow.set(row.key, (batchesByRow.get(row.key) ?? new Set()).add(row.batch));
    }

    const fileKeys = fileRows.map(values => signature(values)?.key);
    const comparedRows = fileKeys.filter(key => key !== undefined).length;
    const linesByBatch = new Map<string, number[]>();
    fileKeys.forEach((key, index) => {
        for (const batch of (key && batchesByRow.get(key)) || [])
            linesByBatch.set(batch, [...(linesByBatch.get(batch) ?? []), index + 1]);
    });

    const blockingErrors: ConsistencyError[] = [];
    const warnings: ConsistencyError[] = [];
    for (const [storedBatch, lines] of [...linesByBatch].sort(([a], [b]) => a.localeCompare(b))) {
        const where = storedBatch === batchId ? `the dataset you chose (${storedBatch})` : `dataset ${storedBatch}`;
        if (storedBatch !== batchId && lines.length === comparedRows)
            blockingErrors.push({
                error:
                    `Every row of this file is already stored under ${where} of this year, so it would be counted ` +
                    `twice. Upload each file only once. If ${storedBatch} holds the wrong file, delete that upload first.`,
                count: lines.length,
                lines,
            });
        else
            warnings.push({
                error:
                    `${lines.length} of the ${comparedRows} rows of this file are already stored under ${where} of ` +
                    `this year. Please check that these rows are not counted twice.`,
                count: lines.length,
                lines,
            });
    }
    return { blockingErrors, warnings };
}
