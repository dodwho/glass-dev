import { AsyncUploadProgress } from "../../domain/entities/AsyncUploadProgress";
import { Future, FutureData } from "../../domain/entities/Future";
import { Id } from "../../domain/entities/Ref";
import { AsyncUploadProgressRepository } from "../../domain/repositories/AsyncUploadProgressRepository";
import { D2Api, DataStore } from "../../types/d2-api";
import { apiToFuture } from "../../utils/futures";
import { Maybe } from "../../utils/ts-utils";

// Own namespace with one key per upload, so progress writes never race with the shared "async-uploads" list.
// Missing keys and a missing namespace are answered as "not found" by d2-api, not as errors.
const NAMESPACE = "glass-async-upload-progress";
const ID_CHUNK_SEPARATOR = "-ids-";

export class AsyncUploadProgressDataStoreRepository implements AsyncUploadProgressRepository {
    private dataStore: DataStore;

    constructor(api: D2Api) {
        this.dataStore = api.dataStore(NAMESPACE);
    }

    get(uploadId: Id): FutureData<Maybe<AsyncUploadProgress>> {
        return apiToFuture(this.dataStore.get<AsyncUploadProgress>(uploadId));
    }

    getAll(): FutureData<AsyncUploadProgress[]> {
        return apiToFuture(this.dataStore.getKeys())
            .flatMap(keys =>
                Future.sequential(keys.filter(key => !key.includes(ID_CHUNK_SEPARATOR)).map(key => this.get(key)))
            )
            .map(progresses => progresses.flatMap(progress => (progress ? [progress] : [])));
    }

    save(progress: AsyncUploadProgress): FutureData<void> {
        return apiToFuture(this.dataStore.save(progress.uploadId, progress));
    }

    saveTrackedEntityIds(uploadId: Id, chunkIndex: number, trackedEntityIds: Id[]): FutureData<void> {
        return apiToFuture(this.dataStore.save(idChunkKey(uploadId, chunkIndex), trackedEntityIds));
    }

    getTrackedEntityIds(uploadId: Id, chunkIndex: number): FutureData<Id[]> {
        return apiToFuture(this.dataStore.get<Id[]>(idChunkKey(uploadId, chunkIndex))).map(ids => ids ?? []);
    }

    // Id lists go first and the record last, so an interrupted removal still leaves the record to retry from.
    remove(progress: AsyncUploadProgress): FutureData<void> {
        const keys = Array.from({ length: progress.savedIdChunks }, (_, index) => idChunkKey(progress.uploadId, index));
        return Future.sequential([...keys, progress.uploadId].map(key => apiToFuture(this.dataStore.delete(key)))).map(
            () => undefined
        );
    }
}

function idChunkKey(uploadId: Id, chunkIndex: number): string {
    return `${uploadId}${ID_CHUNK_SEPARATOR}${chunkIndex}`;
}
