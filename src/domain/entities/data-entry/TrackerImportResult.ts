export interface TrackerImportErrorReport {
    message: string;
    errorCode: string;
    uid: string;
}

export interface TrackerImportStats {
    created: number;
    updated: number;
    deleted: number;
    ignored: number;
    total: number;
}

interface TrackerImportTypeReport {
    objectReports: { uid: string }[];
}

/** The outcome of a tracker import, as far as the domain needs to know about it. */
export interface TrackerImportResult {
    status: "OK" | "ERROR" | "WARNING";
    message: string;
    stats: TrackerImportStats;
    validationReport: {
        errorReports: TrackerImportErrorReport[];
        warningReports: TrackerImportErrorReport[];
    };
    bundleReport: {
        typeReportMap: {
            EVENT: TrackerImportTypeReport;
            TRACKED_ENTITY: TrackerImportTypeReport;
        };
    };
}
