import { Future } from "../../../domain/entities/Future";
import { GlassDocuments } from "../../../domain/entities/GlassDocuments";
import { DataStoreClient } from "../../data-store/DataStoreClient";
import { Instance } from "../../entities/Instance";
import { GlassDocumentsDefaultRepository } from "../GlassDocumentsDefaultRepository";

// Every upload rewrites the DataStore list glass/documents whole, so RIS and SAMPLE attached together can lose an
// entry (29 live PROD uploads, Oct 2026). Deleting such an upload failed after its record was gone, leaving the file.
describe("GlassDocumentsDefaultRepository.delete", () => {
    const document = (id: string) => ({ id, fileResourceId: `fr-${id}`, createdAt: "2026-10-25T00:00:00Z" });

    function repository(documents: GlassDocuments[]) {
        const saveObject = jest.fn(() => Future.success(undefined));
        const dataStoreClient = {
            listCollection: () => Future.success(documents),
            saveObject,
        } as unknown as DataStoreClient;
        const instance = new Instance({ url: "http://localhost" });
        return { saveObject, repository: new GlassDocumentsDefaultRepository(dataStoreClient, instance) };
    }

    it("removes the document from the list and returns its id", async () => {
        const { saveObject, repository: documents } = repository([document("doc1"), document("doc2")]);

        expect(await documents.delete("doc1").toPromise()).toBe("doc1");
        expect(saveObject).toHaveBeenCalledWith("documents", [document("doc2")]);
    });

    it("returns the id without rewriting the list when the list misses the document", async () => {
        const { saveObject, repository: documents } = repository([document("doc2")]);

        expect(await documents.delete("doc1").toPromise()).toBe("doc1");
        expect(saveObject).not.toHaveBeenCalled();
    });
});
