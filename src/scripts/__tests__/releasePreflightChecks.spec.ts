import * as references from "../../domain/entities/GlassMetadataReferences";
import { uploadsDHIS2Ids } from "../../data/repositories/GlassUploadsProgramRepository";
import { collectReferenceIds, findMissing } from "../utils/releasePreflightChecks";

describe("collectReferenceIds", () => {
    it("separates module ids from metadata ids and reads nested objects", () => {
        const { metadataIds, moduleIds } = collectReferenceIds({
            AMR_MODULE_ID: "AVnpk4xiXGG",
            EAR_PROGRAM_ID: "SQe26z0smFP",
            QUESTIONS: { communityPublic: "OyEpE54Ni9M" },
            NOT_AN_ID: "hello",
            A_NUMBER: 3,
        });

        expect(moduleIds).toEqual([{ name: "AMR_MODULE_ID", id: "AVnpk4xiXGG" }]);
        expect(metadataIds).toEqual([
            { name: "EAR_PROGRAM_ID", id: "SQe26z0smFP" },
            { name: "QUESTIONS.communityPublic", id: "OyEpE54Ni9M" },
        ]);
    });

    it("finds every id in GlassMetadataReferences, including the 4 module ids", () => {
        const { metadataIds, moduleIds } = collectReferenceIds(references);

        expect(moduleIds.map(({ id }) => id).sort()).toEqual(
            ["AVnpk4xiXGG", "BVnik5xiXGJ", "CVVp44xiXGJ", "IVnpk5xiXGG"].sort()
        );
        expect(metadataIds.map(({ id }) => id)).toEqual(
            expect.arrayContaining(["oo0bqS0AqMI", "mMAj6Gofe49", "OyEpE54Ni9M"])
        );
    });
});

describe("findMissing", () => {
    it("lists only the entries not found", () => {
        const expected = [
            { name: "a", id: "aaaaaaaaaaa" },
            { name: "b", id: "bbbbbbbbbbb" },
        ];

        expect(findMissing(expected, ["aaaaaaaaaaa"])).toEqual([{ name: "b", id: "bbbbbbbbbbb" }]);
        expect(findMissing(expected, ["aaaaaaaaaaa", "bbbbbbbbbbb"])).toEqual([]);
    });
});

describe("uploads program data elements", () => {
    it("include the three audit-trail data elements the release needs on every instance", () => {
        expect(uploadsDHIS2Ids).toMatchObject({
            deletionRequestedBy: "qROG1TPI09C",
            deletionRequestedAt: "EQ8KdQ0aaic",
            deletionReason: "m870FaDlihh",
        });
    });
});
