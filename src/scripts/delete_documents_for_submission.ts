import { command, run } from "cmd-ts";
import path from "path";
import { describeAuth, getEnvVars, getInstance, warmUpSession } from "./common";
import dotenv from "dotenv";
import { DataStoreClient } from "../data/data-store/DataStoreClient";
import { GlassDocumentsDefaultRepository } from "../data/repositories/GlassDocumentsDefaultRepository";
import { Instance } from "../data/entities/Instance";
import { DeleteDocumentInfoByUploadIdUseCase } from "../domain/usecases/DeleteDocumentInfoByUploadIdUseCase";
import { GlassUploadsProgramRepository } from "../data/repositories/GlassUploadsProgramRepository";
import { getUploadsFormDataBuilder } from "../utils/getUploadsFormDataBuilder";
import { getD2APiFromInstance } from "../utils/d2-api";
dotenv.config();

let instance: Instance;
let dataStoreClient: DataStoreClient;
let glassDocumentsRepository: GlassDocumentsDefaultRepository;
let glassUploadsRepository: GlassUploadsProgramRepository;
let deleteDocumentInfoByUploadIdUseCase: DeleteDocumentInfoByUploadIdUseCase;

// Initialize the global variables
async function initializeGlobals(envVars: any) {
    instance = getInstance(envVars);
    dataStoreClient = new DataStoreClient(instance);
    glassDocumentsRepository = new GlassDocumentsDefaultRepository(dataStoreClient, instance);
    const api = getD2APiFromInstance(instance);
    await warmUpSession(api);
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
            }),
          period: option({
                type: string,
                long: "period",
                description: "The period to run amr-agg data reset for",
            }),
            batchId: option({
                type: string,
                long: "batchId",
                description: "The batchId/dataset to run amr-agg data reset for",
            }),*/
        },
        handler: async args => {
            const envVars = getEnvVars();
            console.log(`Target instance: ${envVars.url} (auth: ${describeAuth(envVars)})`);

            //const api = getD2ApiFromArgs(envVars);
            // Call this function once to initialize the variables
            await initializeGlobals(envVars);

            //1. Get Period for which to reset.
            /* if (!args.docId) throw new Error("docId is required");
            const docId = args.docId;
 
             //2. Get OrgUnit for which to reset.
             if (!args.orgUnitId) throw new Error("OrgUnit is required");
             const orgUnitId = args.orgUnitId;
 
             //3. Get Batch Id to reset
             if (!args.orgUnitId) throw new Error("OrgUnit is required");
             const batchId = args.batchId;*/

            //4. Set AMR-AGG dataset id.
            // const dataSetId = "CeQPmXgrhHF";

            //1: Get the directory

            try {
                const uploads = await glassUploadsRepository.getUploadsByDataSubmission("M1NYa4SHi4w").toPromise();
                for (const upload of uploads) {
                    deleteDocumentInfoByUploadIdUseCase.execute(upload.id);
                }
            } catch (error) {
                console.error(`Error thrown while trying to delete Document: ${error}`);
            }
        },
    });

    run(cmd, process.argv.slice(2));
}

main();
