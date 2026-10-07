import { command, option, run, string } from "cmd-ts";
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
import { StatusChangedBy } from "../domain/entities/GlassDataSubmission";
import dotenv from "dotenv";
import { DataStoreClient } from "../data/data-store/DataStoreClient";
import { GlassDocumentsDefaultRepository } from "../data/repositories/GlassDocumentsDefaultRepository";
import { Instance } from "../data/entities/Instance";
import { DeleteDocumentInfoByUploadIdUseCase } from "../domain/usecases/DeleteDocumentInfoByUploadIdUseCase";
import { GlassUploadsProgramRepository } from "../data/repositories/GlassUploadsProgramRepository";
import { getD2APiFromInstance } from "../utils/d2-api";
import { getUploadsFormDataBuilder } from "../utils/getUploadsFormDataBuilder";
dotenv.config();

let instance: Instance;
let dataStoreClient: DataStoreClient;
let glassDocumentsRepository: GlassDocumentsDefaultRepository;
let glassUploadsRepository: GlassUploadsProgramRepository;
let tokenOwner: StatusChangedBy;
let deleteDocumentInfoByUploadIdUseCase: DeleteDocumentInfoByUploadIdUseCase;

// Initialize the global variables
async function initializeGlobals(envVars: any) {
    instance = getInstance(envVars);
    dataStoreClient = new DataStoreClient(instance);
    glassDocumentsRepository = new GlassDocumentsDefaultRepository(dataStoreClient, instance);
    const api = getD2APiFromInstance(instance);
    await warmUpSession(api);
    tokenOwner = await getTokenOwner(api);
    const runtime: "node" | "browser" = typeof window === "undefined" ? "node" : "browser";
    const uploadsFormDataBuilder = getUploadsFormDataBuilder(runtime);
    glassUploadsRepository = new GlassUploadsProgramRepository(api, uploadsFormDataBuilder);
    deleteDocumentInfoByUploadIdUseCase = new DeleteDocumentInfoByUploadIdUseCase(
        glassDocumentsRepository,
        glassUploadsRepository
    );
}

function main() {
    const cmd = command({
        name: path.basename(__filename),
        description: "Show DHIS2 instance info",
        args: {
            /* docId: option({
               type: string,
               long: "docId",
               description: "The docId of the document to delete",
           }),*/
            uploadId: option({
                type: string,
                long: "uploadId",
                description: "The uploadId",
            }),
            reason: deletionReasonOption,
            // fileId: option({
            //    type: string,
            //     long: "fileId",
            //    description: "The fileId",
            //}),
        },
        handler: async args => {
            const envVars = getEnvVars();
            console.log(`Target instance: ${envVars.url} (auth: ${describeAuth(envVars)})`);

            //const api = getD2ApiFromArgs(envVars);
            // Call this function once to initialize the variables
            await initializeGlobals(envVars);

            //1. Get Period for which to reset.
            if (!args.uploadId) throw new Error("uploadId is required");
            const uploadId = args.uploadId;

            //2. Get OrgUnit for which to reset.
            //if (!args.fileId) throw new Error("fileId is required");
            // const fileId = args.fileId;
            /*
              //3. Get Batch Id to reset
              if (!args.orgUnitId) throw new Error("OrgUnit is required");
              const batchId = args.batchId;*/

            //4. Set AMR-AGG dataset id.
            // const dataSetId = "CeQPmXgrhHF";

            //1: Get the directory

            try {
                await recordDeletionRequest(glassUploadsRepository, {
                    uploadId: uploadId,
                    tokenOwner: tokenOwner,
                    reason: args.reason,
                });
                await glassUploadsRepository.delete(uploadId).toPromise();
                console.log("deleted the upload with uploadId: " + uploadId);
                deleteDocumentInfoByUploadIdUseCase.execute(uploadId);
                //console.log("deleted the file with fileId: " + fileId);//
            } catch (error) {
                console.error(`Error thrown while trying to delete Document: ${error}`);
            }
        },
    });

    run(cmd, process.argv.slice(2));
}

main();
