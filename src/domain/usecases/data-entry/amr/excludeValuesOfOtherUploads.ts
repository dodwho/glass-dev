import { Future, FutureData } from "../../../entities/Future";
import { DataValue } from "../../../entities/data-entry/DataValue";
import { GlassUploads, GlassUploadsStatus } from "../../../entities/GlassUploads";
import { MODULE_NAMES } from "../../../entities/GlassModule";
import { GlassDocumentsRepository } from "../../../repositories/GlassDocumentsRepository";
import { GlassModuleRepository } from "../../../repositories/GlassModuleRepository";
import { GlassUploadsRepository } from "../../../repositories/GlassUploadsRepository";
import { moduleProperties } from "../../../utils/ModuleProperties";
import { DownloadDocumentAsArrayBufferUseCase } from "../../DownloadDocumentAsArrayBufferUseCase";
import { GetGlassUploadsIncludedSharedByModuleOUPeriodUseCase } from "../../GetGlassUploadsIncludedSharedByModuleOUPeriodUseCase";

const LIVE_STATUSES: GlassUploadsStatus[] = ["IMPORTED", "VALIDATED", "COMPLETED"];

/** AMR aggregate's SAMPLE and AMR - Individual's "SAMPLE File" are stored in the same SAMPLE data set. */
const SAMPLE_FILE_TYPES = [MODULE_NAMES.AMR, MODULE_NAMES.AMR_INDIVIDUAL].map(name =>
    moduleProperties.get(name)?.secondaryFileType.toUpperCase()
);
const dataSetOf = (fileType: string) =>
    SAMPLE_FILE_TYPES.includes(fileType.toUpperCase()) ? "SAMPLE" : fileType.toUpperCase();

const cellKey = (value: DataValue) =>
    [value.orgUnit, value.period, value.dataElement, value.categoryOptionCombo, value.attributeOptionCombo].join("|");

/**
 * The values of an AMR aggregate upload's file that deleting the upload may remove: those that no other live
 * (IMPORTED, VALIDATED or COMPLETED) upload's file of the same country, year and data set maps to, in AMR or
 * AMR - Individual. Such a cell is that upload's data too (the same batch uploaded twice, a file whose rows name
 * another batch, or an AMR - Individual SAMPLE file).
 * If another upload's file cannot be read, nothing is returned but the error: a blind delete could remove its data.
 */
export function excludeValuesOfOtherUploads(
    upload: GlassUploads,
    dataValues: DataValue[],
    mapFile: (arrayBuffer: ArrayBuffer) => FutureData<DataValue[]>,
    repositories: {
        glassUploadsRepository: GlassUploadsRepository;
        glassDocumentsRepository: GlassDocumentsRepository;
        glassModuleRepository: GlassModuleRepository;
    }
): FutureData<DataValue[]> {
    const downloadFile = new DownloadDocumentAsArrayBufferUseCase(repositories.glassDocumentsRepository);

    return new GetGlassUploadsIncludedSharedByModuleOUPeriodUseCase(
        repositories.glassUploadsRepository,
        repositories.glassModuleRepository
    )
        .execute(upload.module, upload.orgUnit, upload.period)
        .flatMap(uploads => {
            const otherLiveUploads = uploads.filter(
                other =>
                    other.id !== upload.id &&
                    dataSetOf(other.fileType) === dataSetOf(upload.fileType) &&
                    LIVE_STATUSES.includes(other.status)
            );

            return Future.sequential(
                otherLiveUploads.map(other =>
                    downloadFile
                        .execute(other.fileId)
                        .flatMap(mapFile)
                        .mapError(
                            error =>
                                `Nothing was deleted: the file of upload ${other.fileName} (${other.id}), which may hold some of the same data, could not be read: ${error}`
                        )
                )
            );
        })
        .map(otherFilesValues => {
            const heldByOtherUploads = new Set(otherFilesValues.flat().map(cellKey));
            return dataValues.filter(value => !heldByOtherUploads.has(cellKey(value)));
        });
}
