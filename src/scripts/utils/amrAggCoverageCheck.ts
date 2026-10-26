/**
 * Cross-check of an AMR aggregate export against the uploads program: which country/years have data
 * stored in the data set but no upload record that reached it, and the reverse. Failed units are left
 * out, since whether they hold data is unknown.
 */

export type CoverageIssue = "DATA_WITHOUT_UPLOAD" | "UPLOAD_WITHOUT_DATA";

export interface CoverageMismatch {
    fileType: string;
    orgUnitCode: string;
    year: string;
    issue: CoverageIssue;
}

export interface CheckedUnit {
    orgUnitCode: string;
    orgUnitId: string;
    year: string;
    status: "SUCCEEDED" | "FAILED";
    dataValuesRead: number;
}

/** coverageKeys holds `${orgUnitId}|${year}|${fileType}`, as built by the export's coverage lookup. */
export function findCoverageMismatches(
    fileType: string,
    units: CheckedUnit[],
    coverageKeys: Set<string>
): CoverageMismatch[] {
    return units
        .filter(unit => unit.status === "SUCCEEDED")
        .flatMap((unit): CoverageMismatch[] => {
            const hasData = unit.dataValuesRead > 0;
            const hasUpload = coverageKeys.has(`${unit.orgUnitId}|${unit.year}|${fileType}`);
            if (hasData === hasUpload) return [];
            const issue = hasData ? "DATA_WITHOUT_UPLOAD" : "UPLOAD_WITHOUT_DATA";
            return [{ fileType, orgUnitCode: unit.orgUnitCode, year: unit.year, issue }];
        })
        .sort((a, b) => a.year.localeCompare(b.year) || a.orgUnitCode.localeCompare(b.orgUnitCode));
}
