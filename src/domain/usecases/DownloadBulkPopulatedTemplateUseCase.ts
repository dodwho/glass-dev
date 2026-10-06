import { UseCase } from "../UseCase";
import { EGASPProgramRepository } from "../repositories/EGASPProgramRepository";
import { DataPackage } from "../entities/data-entry/DataPackage";
import { TrackedEntityInstance } from "../entities/TrackedEntityInstance";
import { Future, FutureData } from "../entities/Future";
import { DownloadTemplateRepository } from "../repositories/DownloadTemplateRepository";
import { ExcelRepository } from "../repositories/ExcelRepository";
import { MetadataRepository } from "../repositories/MetadataRepository";
import { DownloadTemplate, DownloadType, NO_CALCULATED_DATA_AVAILABLE } from "../utils/DownloadTemplate";

export interface DownloadBulkPopulatedTemplateOptions {
    /** Max concurrent per-org-unit fetches. Defaults to 1 (sequential) when omitted. */
    fetchConcurrency?: number;
    /** Skips fetching entirely and populates with this package instead — see prefetchDataPackage. */
    prefetchedDataPackage?: DataPackage;
    /** Optional id -> human-readable label (e.g. country code), used only for progress logging. */
    orgUnitLabels?: Record<string, string>;
}

/**
 * Sibling of DownloadPopulatedTemplateUseCase for bulk exports: combines several org units and
 * several (possibly non-contiguous) years into one populated workbook, in the exact upload-template
 * column format. See DownloadTemplate.downloadTemplate's `periods` handling for how multi-year data
 * is fetched and merged.
 */
export class DownloadBulkPopulatedTemplateUseCase implements UseCase {
    constructor(
        private downloadTemplateRepository: DownloadTemplateRepository,
        private excelRepository: ExcelRepository,
        private egaspRepository: EGASPProgramRepository,
        private metadataRepository: MetadataRepository
    ) {}

    public execute(
        moduleName: string,
        orgUnits: string[],
        periods: string[],
        fileType: string,
        // Optional: when omitted for a multi-stage program (AMC PRODUCT), the generated workbook
        // contains every program stage as its own tab (SUBMITTED + CALCULATED in one file) instead
        // of a single stage. getProgramId returns no programStageId in that case, so sheetBuilder
        // emits all accessible stages and each event is written to its own stage's tab at populate time.
        downloadType: DownloadType | undefined,
        options?: DownloadBulkPopulatedTemplateOptions
    ): FutureData<File> {
        const downloadRelationships = moduleName === "AMC" && fileType === "PRODUCT" ? true : false;
        const filterTEIEnrollmentDate = downloadRelationships;

        const downloadTemplate = new DownloadTemplate(
            this.downloadTemplateRepository,
            this.excelRepository,
            this.egaspRepository
        );
        return Future.fromPromise(
            downloadTemplate
                .downloadTemplate({
                    moduleName,
                    fileType,
                    orgUnits,
                    populate: true,
                    downloadRelationships,
                    useCodesForMetadata: moduleName === "EGASP" || moduleName === "AMC",
                    downloadType,
                    periods,
                    filterTEIEnrollmentDate,
                    fetchConcurrency: options?.fetchConcurrency,
                    prefetchedDataPackage: options?.prefetchedDataPackage,
                    orgUnitLabels: options?.orgUnitLabels,
                })
                .catch(e => {
                    // NO_CALCULATED_DATA_AVAILABLE is an expected, handled outcome (the caller records
                    // it as SKIPPED), not a failure — don't dump a scary error object for it. Genuine
                    // failures still get the full detail.
                    if (e?.message !== NO_CALCULATED_DATA_AVAILABLE) {
                        console.error("[AMC bulk download] DownloadBulkPopulatedTemplateUseCase failed:", {
                            moduleName,
                            fileType,
                            downloadType,
                            orgUnits,
                            periods,
                            error: e,
                            stack: e?.stack,
                        });
                    }
                    throw e;
                })
        );
    }

    /**
     * Fetches the combined DataPackage for (orgUnits × periods × fileType) standalone, without
     * building a workbook. For PRODUCT, SUBMITTED and CALCULATED share the same programId (they
     * differ only by programStageId, applied at populate time) — so the caller can prefetch once
     * here with downloadType="SUBMITTED" and pass the result as `prefetchedDataPackage` to two
     * `execute()` calls (SUBMITTED and CALCULATED), fetching the org-unit data only once instead
     * of twice. Not meaningful for SUBSTANCE, whose SUBMITTED/CALCULATED programIds differ.
     *
     * Also the entry point for consumers that want the data WITHOUT a workbook at all (the bulk CSV
     * export): `options.downloadType` selects the substance program to read, and the two workbook-
     * oriented behaviours — option code -> uid translation and the xlsx per-sheet row cap — can be
     * turned off there. Omitting `options` keeps the original prefetch behaviour exactly.
     */
    public prefetchDataPackage(
        moduleName: string,
        orgUnits: string[],
        periods: string[],
        fileType: string,
        fetchConcurrency?: number,
        orgUnitLabels?: Record<string, string>,
        options?: {
            downloadType?: DownloadType;
            translateCodes?: boolean;
            enforceSheetRowLimit?: boolean;
            /** See DownloadTemplate.getMultiPeriodDataPackage. Set when the caller already holds the
             *  complete tracked-entity register from prefetchProductRegister and wants events only. */
            skipTrackedEntityInstances?: boolean;
        }
    ): FutureData<DataPackage> {
        const downloadRelationships = moduleName === "AMC" && fileType === "PRODUCT" ? true : false;
        const filterTEIEnrollmentDate = downloadRelationships;

        const downloadTemplate = new DownloadTemplate(
            this.downloadTemplateRepository,
            this.excelRepository,
            this.egaspRepository
        );
        return Future.fromPromise(
            downloadTemplate
                .getDataPackageForPeriods({
                    moduleName,
                    fileType,
                    downloadType: options?.downloadType ?? "SUBMITTED",
                    orgUnits,
                    periods,
                    filterTEIEnrollmentDate,
                    fetchConcurrency,
                    orgUnitLabels,
                    translateCodes: options?.translateCodes,
                    enforceSheetRowLimit: options?.enforceSheetRowLimit,
                    skipTrackedEntityInstances: options?.skipTrackedEntityInstances,
                })
                .catch(e => {
                    console.error("[AMC bulk download] prefetchDataPackage failed:", {
                        moduleName,
                        fileType,
                        orgUnits,
                        periods,
                        error: e,
                        stack: e?.stack,
                    });
                    throw e;
                })
        );
    }

    /**
     * Fetches the complete tracked-entity register for a tracker program (AMC PRODUCT), unfiltered by
     * enrollment date, once — not scoped to any particular year. Pair with prefetchDataPackage's
     * `skipTrackedEntityInstances` option for the per-year event fetches: this call gets the register
     * exactly once per run; every subsequent per-year fetch skips re-fetching it. See
     * DownloadTemplate.getTrackedEntityRegister for why a per-year-scoped register would be wrong (a
     * product enrolls once but reports consumption for years afterward).
     */
    public prefetchProductRegister(
        moduleName: string,
        orgUnits: string[],
        fetchConcurrency?: number,
        orgUnitLabels?: Record<string, string>
    ): FutureData<TrackedEntityInstance[]> {
        const downloadTemplate = new DownloadTemplate(
            this.downloadTemplateRepository,
            this.excelRepository,
            this.egaspRepository
        );
        return Future.fromPromise(
            downloadTemplate
                .getTrackedEntityRegister({
                    moduleName,
                    fileType: "PRODUCT",
                    orgUnits,
                    fetchConcurrency,
                    orgUnitLabels,
                })
                .catch(e => {
                    console.error("[AMC bulk download] prefetchProductRegister failed:", {
                        moduleName,
                        orgUnits,
                        error: e,
                        stack: e?.stack,
                    });
                    throw e;
                })
        );
    }
}
