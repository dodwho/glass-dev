import { Future } from "../../../domain/entities/Future";
import { GlassDataSubmission } from "../../../domain/entities/GlassDataSubmission";
import { DataStoreClient } from "../../data-store/DataStoreClient";
import { GlassDataSubmissionsDefaultRepository } from "../GlassDataSubmissionDefaultRepository";

describe("GlassDataSubmissionsDefaultRepository.setStatus", () => {
    const changedBy = { id: "userId12345", username: "some.user" };

    function buildSubmission(): GlassDataSubmission {
        return { id: "ds1", module: "AMR", orgUnit: "ou1", period: "2024", status: "COMPLETE", statusHistory: [] };
    }

    it("stores who changed the status in the status history", async () => {
        const saveObject = jest.fn(() => Future.success(undefined));
        const dataStoreClient = {
            listCollection: () => Future.success([buildSubmission()]),
            saveObject,
        } as unknown as DataStoreClient;

        await new GlassDataSubmissionsDefaultRepository(dataStoreClient)
            .setStatus("ds1", "PENDING_APPROVAL", changedBy)
            .toPromise();

        const [, saved] = saveObject.mock.calls[0] as unknown as [string, GlassDataSubmission[]];
        expect(saved[0]?.status).toBe("PENDING_APPROVAL");
        expect(saved[0]?.statusHistory).toEqual([
            expect.objectContaining({ from: "COMPLETE", to: "PENDING_APPROVAL", changedBy }),
        ]);
    });
});
