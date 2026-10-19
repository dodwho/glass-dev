import { Future, FutureData } from "../../../domain/entities/Future";
import { GlassAsyncDeletion } from "../../../domain/entities/GlassAsyncDeletions";
import { GlassAsyncUpload } from "../../../domain/entities/GlassAsyncUploads";
import { DataStoreClient } from "../../data-store/DataStoreClient";
import { GlassAsyncDeletionsDefaultRepository } from "../GlassAsyncDeletionsDefaultRepository";
import { GlassAsyncUploadsDefaultRepository } from "../GlassAsyncUploadsDefaultRepository";

/** In-memory DataStore that, like DHIS2, stores JSON: fields set to undefined are dropped. */
class FakeDataStoreClient {
    values = new Map<string, unknown>();
    saves = 0;

    listCollection<T>(key: string): FutureData<T[]> {
        return Future.success((this.values.get(key) as T[] | undefined) ?? []);
    }

    saveObject<T extends object>(key: string, value: T): FutureData<void> {
        this.saves++;
        this.values.set(key, JSON.parse(JSON.stringify(value)));
        return Future.success(undefined);
    }
}

function run<D>(future: FutureData<D>): Promise<D> {
    return future.toPromise();
}

describe("GlassAsyncUploadsDefaultRepository", () => {
    const setUp = (asyncUploads: GlassAsyncUpload[]) => {
        const dataStore = new FakeDataStoreClient();
        dataStore.values.set("async-uploads", asyncUploads);
        const repository = new GlassAsyncUploadsDefaultRepository(dataStore as unknown as DataStoreClient);
        const stored = () => dataStore.values.get("async-uploads") as GlassAsyncUpload[];
        return { repository, stored };
    };

    it("records when an upload starts and clears it when it is reset", async () => {
        const { repository, stored } = setUp([
            { uploadId: "up1", type: "primary", attempts: 0, status: "PENDING" },
            { uploadId: "up2", type: "secondary", attempts: 1, status: "PENDING" },
        ]);

        await run(repository.setStatus("up1", "UPLOADING"));
        const startedAt = stored()[0]?.uploadingStartedAt;
        expect(Date.now() - new Date(startedAt ?? 0).getTime()).toBeLessThan(5000);
        expect(stored()[1]).toEqual({ uploadId: "up2", type: "secondary", attempts: 1, status: "PENDING" });

        await run(repository.setStatus("up1", "PENDING"));
        expect(stored()[0]).toEqual({ uploadId: "up1", type: "primary", attempts: 0, status: "PENDING" });

        await run(repository.setStatus("up1", "UPLOADING"));
        await run(repository.incrementAsyncUploadAttemptsAndResetStatus("up1"));
        expect(stored().find(item => item.uploadId === "up1")).toEqual({
            uploadId: "up1",
            type: "primary",
            attempts: 1,
            status: "PENDING",
        });
    });
});

describe("GlassAsyncDeletionsDefaultRepository", () => {
    const setUp = (asyncDeletions: GlassAsyncDeletion[]) => {
        const dataStore = new FakeDataStoreClient();
        dataStore.values.set("async-deletions", asyncDeletions);
        const repository = new GlassAsyncDeletionsDefaultRepository(dataStore as unknown as DataStoreClient);
        const stored = () => dataStore.values.get("async-deletions") as GlassAsyncDeletion[];
        return { dataStore, repository, stored };
    };

    it("records a sign of life on a running deletion only", async () => {
        const { dataStore, repository, stored } = setUp([
            { uploadId: "up1", attempts: 0, status: "DELETING", deletingStartedAt: "2026-10-19T08:00:00.000Z" },
            { uploadId: "up2", attempts: 0, status: "PENDING" },
        ]);

        await run(repository.setLastSeenAt("up1", "2026-10-19T09:00:00.000Z"));
        expect(stored()[0]?.lastSeenAt).toBe("2026-10-19T09:00:00.000Z");

        const savesBefore = dataStore.saves;
        await run(repository.setLastSeenAt("up2", "2026-10-19T09:00:00.000Z"));
        await run(repository.setLastSeenAt("gone", "2026-10-19T09:00:00.000Z"));
        expect(dataStore.saves).toBe(savesBefore);
        expect(stored()[1]).toEqual({ uploadId: "up2", attempts: 0, status: "PENDING" });
    });

    it("clears the sign of life when the status changes or the deletion is reset", async () => {
        const { repository, stored } = setUp([
            {
                uploadId: "up1",
                attempts: 0,
                status: "DELETING",
                deletingStartedAt: "2026-10-19T08:00:00.000Z",
                lastSeenAt: "2026-10-19T09:00:00.000Z",
            },
        ]);

        await run(repository.setStatus(["up1"], "DELETING"));
        expect(stored()[0]?.lastSeenAt).toBeUndefined();
        expect(stored()[0]?.deletingStartedAt).not.toBe("2026-10-19T08:00:00.000Z");

        await run(repository.setLastSeenAt("up1", "2026-10-19T10:00:00.000Z"));
        await run(repository.incrementAsyncDeletionAttemptsAndResetStatus("up1"));
        expect(stored()[0]).toEqual({ uploadId: "up1", attempts: 1, status: "PENDING" });
    });
});
