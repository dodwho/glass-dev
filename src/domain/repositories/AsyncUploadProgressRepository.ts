import { AsyncUploadProgress } from "../entities/AsyncUploadProgress";
import { FutureData } from "../entities/Future";
import { Id } from "../entities/Ref";
import { Maybe } from "../../utils/ts-utils";

export interface AsyncUploadProgressRepository {
    get(uploadId: Id): FutureData<Maybe<AsyncUploadProgress>>;
    getAll(): FutureData<AsyncUploadProgress[]>;
    save(progress: AsyncUploadProgress): FutureData<void>;
    saveTrackedEntityIds(uploadId: Id, chunkIndex: number, trackedEntityIds: Id[]): FutureData<void>;
    getTrackedEntityIds(uploadId: Id, chunkIndex: number): FutureData<Id[]>;
    remove(progress: AsyncUploadProgress): FutureData<void>;
}
