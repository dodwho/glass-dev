import { command, run, string, option } from "cmd-ts";
import path from "path";
import {
    deletionReasonOption,
    describeAuth,
    getEnvVars,
    getInstance,
    getTokenOwner,
    recordDeletionRequest,
    warmUpSession,
} from "./common";
import dotenv from "dotenv";
import { GlassDataSubmissionsDefaultRepository } from "../data/repositories/GlassDataSubmissionDefaultRepository";
import { DataStoreClient } from "../data/data-store/DataStoreClient";
import { GetSpecificDataSubmissionUseCase } from "../domain/usecases/GetSpecificDataSubmissionUseCase";
import { MetadataDefaultRepository } from "../data/repositories/MetadataDefaultRepository";
import { GlassDocumentsDefaultRepository } from "../data/repositories/GlassDocumentsDefaultRepository";
import { Instance } from "../data/entities/Instance";
import { CodedRef } from "../domain/entities/Ref";
import { StatusChangedBy } from "../domain/entities/GlassDataSubmission";
import { SetDataSubmissionStatusUseCase } from "../domain/usecases/SetDataSubmissionStatusUseCase";
import { DeleteDocumentInfoByUploadIdUseCase } from "../domain/usecases/DeleteDocumentInfoByUploadIdUseCase";
import { GlassUploadsProgramRepository } from "../data/repositories/GlassUploadsProgramRepository";
import { getUploadsFormDataBuilder } from "../utils/getUploadsFormDataBuilder";
import { getD2APiFromInstance } from "../utils/d2-api";
dotenv.config();

let instance: Instance;
let dataStoreClient: DataStoreClient;
let metadataRepository: MetadataDefaultRepository;
let glassDocumentsRepository: GlassDocumentsDefaultRepository;
let glassUploadsRepository: GlassUploadsProgramRepository;
let setSubmissionStatus: SetDataSubmissionStatusUseCase;
let changedBy: StatusChangedBy;
const moduleName = "AMR";
const moduleId = "AVnpk4xiXGG";
let orgUnits: CodedRef[] = [];
let getSpecificDataSubmission: GetSpecificDataSubmissionUseCase;
let glassDataSubmissionRepository: GlassDataSubmissionsDefaultRepository;
let deleteDocumentInfoByUploadIdUseCase: DeleteDocumentInfoByUploadIdUseCase;

// Initialize the global variables
async function initializeGlobals(envVars: any) {
    instance = getInstance(envVars);
    dataStoreClient = new DataStoreClient(instance);
    metadataRepository = new MetadataDefaultRepository(instance);
    const api = getD2APiFromInstance(instance);
    await warmUpSession(api);
    changedBy = await getTokenOwner(api);
    const runtime: "node" | "browser" = typeof window === "undefined" ? "node" : "browser";
    const uploadsFormDataBuilder = getUploadsFormDataBuilder(runtime);
    glassUploadsRepository = new GlassUploadsProgramRepository(api, uploadsFormDataBuilder);
    glassDocumentsRepository = new GlassDocumentsDefaultRepository(dataStoreClient, instance);
    glassDataSubmissionRepository = new GlassDataSubmissionsDefaultRepository(dataStoreClient);
    getSpecificDataSubmission = new GetSpecificDataSubmissionUseCase(glassDataSubmissionRepository);
    setSubmissionStatus = new SetDataSubmissionStatusUseCase(glassDataSubmissionRepository);
    deleteDocumentInfoByUploadIdUseCase = new DeleteDocumentInfoByUploadIdUseCase(
        glassDocumentsRepository,
        glassUploadsRepository
    );
}

async function getOrgUnitIdFromCode(orgUnitCode: string) {
    if (orgUnits.length === 0) {
        orgUnits = await metadataRepository
            .getOrgUnitsByCode([orgUnitCode])
            .toPromise()
            .catch(error => {
                console.error(`Error thrown when fetching all orgUnits, error : ${error}`);
                throw error;
            });
    }
    //console.log("getOrgUnitIdFromCode orgUnitId: ", orgUnitId);
    return orgUnits.find(ou => ou.code === orgUnitCode)?.id || "";
}

function main() {
    const cmd = command({
        name: path.basename(__filename),
        description: "Show DHIS2 instance info",
        args: {
            reason: deletionReasonOption,
            period: option({
                type: string,
                long: "period",
                description: "The period to run amr-agg data reset for",
            }),
            orgUnitCode: option({
                type: string,
                long: "orgUnitCode",
                description: "The org unit code to run amr-agg data reset for",
            }),
            /*batchId: option({
                type: string,
                long: "batchId",
                description: "The batchId/dataset to run amr-agg data reset for",
            })
             docId: option({
               type: string,
               long: "docId",
               description: "The docId of the document to delete",
           }),*/
        },
        handler: async args => {
            const envVars = getEnvVars();
            console.log(`Target instance: ${envVars.url} (auth: ${describeAuth(envVars)})`);

            //const api = getD2ApiFromArgs(envVars);
            // Call this function once to initialize the variables
            await initializeGlobals(envVars);

            //1. Get Period for which to reset.
            if (!args.period) throw new Error("Period is required");
            const period = args.period;

            //2. Get OrgUnit for which to reset.
            if (!args.orgUnitCode) throw new Error("OrgUnit is required");
            const orgUnitCode = args.orgUnitCode;

            //3. Get Batch Id to reset
            /*if (!args.batchId) throw new Error("batchId is required");
            const batchId = args.batchId;*/

            //4. Set AMR-AGG dataset id.
            //const dataSetId = "CeQPmXgrhHF";

            try {
                const orgUnitId = await getOrgUnitIdFromCode(orgUnitCode);

                const dataSubmissionId = await getSpecificDataSubmission
                    .execute(moduleId, moduleName, orgUnitId, period, false)
                    .toPromise()
                    .catch(error => {
                        console.error(`Error fetching data submission: ${error}`);
                        throw error;
                    });

                if (!dataSubmissionId) {
                    console.error(
                        "Data submission id not found for OrgUnit: " + orgUnitCode + " and period: " + period
                    );
                    throw new Error(
                        "Data submission ID not found for OrgUnit: " + orgUnitCode + " and period: " + period
                    );
                }

                console.log(dataSubmissionId);
                const uploads = await glassUploadsRepository
                    .getUploadsByDataSubmission(dataSubmissionId.id)
                    .toPromise();
                console.log(`uploads.length: ${uploads.length}`);
                for (const upload of uploads) {
                    await recordDeletionRequest(glassUploadsRepository, {
                        uploadId: upload.id,
                        tokenOwner: changedBy,
                        reason: args.reason,
                    });
                    await glassUploadsRepository.delete(upload.id).toPromise();
                    deleteDocumentInfoByUploadIdUseCase.execute(upload.id);
                }

                setSubmissionStatus.execute(dataSubmissionId.id, "NOT_COMPLETED", changedBy).toPromise();
            } catch (error) {
                console.error(`Error thrown while trying to delete Document: ${error}`);
            }
        },
    });

    run(cmd, process.argv.slice(2));
}

main();
