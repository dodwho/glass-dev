import { DataValue } from "../../../entities/data-entry/DataValue";
import { RISData, toAMRAggDataValue } from "../../../entities/data-entry/amr-external/RISData";
import { SampleData } from "../../../entities/data-entry/amr-external/SampleData";
import { CategoryCombo } from "../../../entities/metadata/CategoryCombo";
import { DataSet } from "../../../entities/metadata/DataSet";
import { CodedRef } from "../../../entities/Ref";
import {
    getCategoryOptionComboByDataElement,
    getCategoryOptionComboByOptionCodes,
} from "../utils/getCategoryOptionCombo";

export interface AMRAggFileMetadata {
    dataSet: DataSet;
    /** The data set's category combo: its option combos are the attribute option combos (pathogen/antibiotic/batch). */
    dataSet_CC: CategoryCombo;
    dataElement_CC: CategoryCombo;
    orgUnits: CodedRef[];
}

export interface AMRAggFileDataValues {
    dataValues: DataValue[];
    categoryOptionErrors: { error: string; line: number }[];
}

/**
 * The data values an AMR aggregate file stands for: one per row and data set data element. The single definition
 * used to import a file (ImportRISFile, ImportSampleFile), to delete it (DeleteRISDataset, DeleteSampleDataset)
 * and to check stored data against it (amr_agg_orphans verify).
 */
function mapRowsToDataValues<Row extends RISData | SampleData>(
    rows: Row[],
    metadata: AMRAggFileMetadata,
    getCategoryValue: (row: Row, code: string) => string,
    getValue: (row: Row, code: string) => string
): AMRAggFileDataValues {
    const { dataSet, dataSet_CC, dataElement_CC, orgUnits } = metadata;
    const categoryOptionErrors: { error: string; line: number }[] = [];

    const dataValues = rows.flatMap((row, index) =>
        dataSet.dataElements.map(dataElement => {
            const dataSetCategoryOptionValues = dataSet_CC.categories.map(category =>
                getCategoryValue(row, category.code)
            );

            const { categoryOptionComboId: attributeOptionCombo, error: aocBlockingError } =
                getCategoryOptionComboByOptionCodes(dataSet_CC, dataSetCategoryOptionValues);

            if (aocBlockingError !== "") categoryOptionErrors.push({ error: aocBlockingError, line: index + 1 });

            const { categoryOptionComboId: categoryOptionCombo, error: ccoBlockingError } =
                getCategoryOptionComboByDataElement(dataElement, dataElement_CC, row);

            if (ccoBlockingError !== "") categoryOptionErrors.push({ error: ccoBlockingError, line: index + 1 });

            return {
                orgUnit: orgUnits.find(ou => ou.code === row.COUNTRY)?.id || "",
                period: row.YEAR.toString(),
                attributeOptionCombo,
                dataElement: dataElement.id,
                categoryOptionCombo,
                value: getValue(row, dataElement.code),
            };
        })
    );

    return { dataValues, categoryOptionErrors };
}

/** An empty RIS result is stored as "0" (toAMRAggDataValue). */
export function mapRISDataToDataValues(rows: RISData[], metadata: AMRAggFileMetadata): AMRAggFileDataValues {
    return mapRowsToDataValues(
        rows,
        metadata,
        (row, code) => String(row[code as keyof RISData]),
        (row, code) => toAMRAggDataValue(row[code as keyof RISData])
    );
}

/** An empty SAMPLE count stays empty, so DHIS2 stores nothing for it. */
export function mapSampleDataToDataValues(rows: SampleData[], metadata: AMRAggFileMetadata): AMRAggFileDataValues {
    return mapRowsToDataValues(
        rows,
        metadata,
        (row, code) => row[code as keyof SampleData].toString(),
        (row, code) => row[code as keyof SampleData]?.toString() || ""
    );
}
