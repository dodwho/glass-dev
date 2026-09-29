import { command, run, string, option } from "cmd-ts";
import path from "path";
import { describeAuth, getEnvVars, getInstance, warmUpSession } from "./common";
import dotenv from "dotenv";
import { DataStoreClient } from "../data/data-store/DataStoreClient";

import { Instance } from "../data/entities/Instance";
import { SetUploadStatusUseCase } from "../domain/usecases/SetUploadStatusUseCase";
import { UpdateSampleUploadWithRisIdUseCase } from "../domain/usecases/UpdateSampleUploadWithRisIdUseCase";
import { GlassUploadsProgramRepository } from "../data/repositories/GlassUploadsProgramRepository";
import { getD2APiFromInstance } from "../utils/d2-api";
import { getUploadsFormDataBuilder } from "../utils/getUploadsFormDataBuilder";
dotenv.config();

let instance: Instance;
let dataStoreClient: DataStoreClient;
let glassUploadsRepository: GlassUploadsProgramRepository;
let setUploadStatusUseCase: SetUploadStatusUseCase;
let updateSecondaryFileWithPrimaryId: UpdateSampleUploadWithRisIdUseCase;

// Initialize the global variables
async function initializeGlobals(envVars: any) {
    instance = getInstance(envVars);
    dataStoreClient = new DataStoreClient(instance);
    const api = getD2APiFromInstance(instance);
    await warmUpSession(api);
    const runtime: "node" | "browser" = typeof window === "undefined" ? "node" : "browser";
    const uploadsFormDataBuilder = getUploadsFormDataBuilder(runtime);
    glassUploadsRepository = new GlassUploadsProgramRepository(api, uploadsFormDataBuilder);
    setUploadStatusUseCase = new SetUploadStatusUseCase(glassUploadsRepository);
    updateSecondaryFileWithPrimaryId = new UpdateSampleUploadWithRisIdUseCase(glassUploadsRepository);
}

function main() {
    const cmd = command({
        name: path.basename(__filename),
        description: "Show DHIS2 instance info",
        args: {
            primaryFileUploadId: option({
                type: string,
                long: "primaryFileUploadId",
                description: "The primaryFileUploadId",
            }),
            secondaryFileUploadId: option({
                type: string,
                long: "secondaryFileUploadId",
                description: "The secondaryFileUploadId",
                defaultValue: () => "",
            }),
        },
        handler: async ({ primaryFileUploadId, secondaryFileUploadId }) => {
            const envVars = getEnvVars();
            console.log(`Target instance: ${envVars.url} (auth: ${describeAuth(envVars)})`);

            //const api = getD2ApiFromArgs(envVars);
            // Call this function once to initialize the variables
            await initializeGlobals(envVars);

            try {
                if (primaryFileUploadId) {
                    await setUploadStatusUseCase.execute({ id: primaryFileUploadId, status: "COMPLETED" }).toPromise();
                }

                if (secondaryFileUploadId && primaryFileUploadId) {
                    await setUploadStatusUseCase
                        .execute({ id: secondaryFileUploadId, status: "COMPLETED" })
                        .toPromise();
                    await updateSecondaryFileWithPrimaryId
                        .execute(secondaryFileUploadId, primaryFileUploadId)
                        .toPromise();
                }
                //setSubmissionStatus.execute(dataSubmissionId.id, "NOT_COMPLETED").toPromise()
            } catch (error) {
                console.error(`Error thrown while trying to delete Document: ${error}`);
            }
        },
    });

    run(cmd, process.argv.slice(2));
}

main();
