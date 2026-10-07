import { Future } from "../../entities/Future";
import { GlassUploadsRepository } from "../../repositories/GlassUploadsRepository";
import { RequestUploadDeletionUseCase } from "../RequestUploadDeletionUseCase";

describe("RequestUploadDeletionUseCase", () => {
    function buildRepository() {
        const requestDeletion = jest.fn(() => Future.success(undefined));
        const repository = { requestDeletion } as unknown as GlassUploadsRepository;
        return { repository, requestDeletion };
    }

    it("refuses a missing reason and writes nothing", async () => {
        const { repository, requestDeletion } = buildRepository();

        await expect(
            new RequestUploadDeletionUseCase(repository)
                .execute({ uploadIds: ["u1"], requestedBy: "some.user", reason: "   " })
                .toPromise()
        ).rejects.toBe("A reason is required to delete an upload");

        expect(requestDeletion).not.toHaveBeenCalled();
    });

    it("records who, when and why on every upload", async () => {
        const { repository, requestDeletion } = buildRepository();

        await new RequestUploadDeletionUseCase(repository)
            .execute({ uploadIds: ["u1", "u2"], requestedBy: "some.user", reason: " wrong file " })
            .toPromise();

        expect(requestDeletion).toHaveBeenCalledTimes(2);
        expect(requestDeletion).toHaveBeenCalledWith(
            "u2",
            expect.objectContaining({ requestedBy: "some.user", reason: "wrong file", requestedAt: expect.any(String) })
        );
    });
});
