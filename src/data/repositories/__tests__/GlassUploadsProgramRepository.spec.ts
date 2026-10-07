import { D2Api } from "../../../types/d2-api";
import { GlassUploads } from "../../../domain/entities/GlassUploads";
import { GlassUploadsProgramRepository, uploadsDHIS2Ids } from "../GlassUploadsProgramRepository";
import { UploadsFormDataBuilder } from "../utils/builders/UploadsFormDataBuilder";

type PostedEvent = { event: string; dataValues: { dataElement: string; value: string | null }[] };

function response<T>(data: T) {
    return { getData: () => Promise.resolve(data), cancel: () => undefined };
}

function buildEvent(overrides: { event?: string; deleted?: boolean; dataValues?: Record<string, string> } = {}) {
    const values: Record<string, string> = {
        [uploadsDHIS2Ids.moduleId]: "IVnpk5xiXGG",
        [uploadsDHIS2Ids.status]: "UPLOADED",
        [uploadsDHIS2Ids.documentName]: "file.csv",
        [uploadsDHIS2Ids.period]: "2024",
        ...overrides.dataValues,
    };
    return {
        event: overrides.event ?? "event000001",
        orgUnit: "countryOu01",
        occurredAt: "2024-01-01",
        createdAt: "2024-02-01",
        createdBy: { username: "uploader.user" },
        deleted: overrides.deleted ?? false,
        dataValues: Object.entries(values).map(([dataElement, value]) => ({ dataElement, value })),
    };
}

function buildRepository(events: ReturnType<typeof buildEvent>[]) {
    const post = jest.fn((_params: unknown, _body: { events: PostedEvent[] }) => response({ status: "OK" }));
    const get = jest.fn((_params: Record<string, unknown>) => response({ instances: events, page: 1, pageCount: 1 }));
    const api = {
        tracker: {
            events: { getById: (id: string) => response(events.find(event => event.event === id)), get },
            post,
        },
    } as unknown as D2Api;

    return { repository: new GlassUploadsProgramRepository(api, {} as UploadsFormDataBuilder), post, get };
}

function postedValues(post: jest.Mock): Record<string, string | null> {
    const [, body] = post.mock.calls[0] as [unknown, { events: PostedEvent[] }];
    const event = body.events[0];
    return Object.fromEntries((event?.dataValues ?? []).map(dv => [dv.dataElement, dv.value]));
}

describe("GlassUploadsProgramRepository audit trail", () => {
    const request = { requestedBy: "admin.user", requestedAt: "2026-10-07T10:00:00.000Z", reason: "Wrong year" };

    it("writes who, when and why on the upload event and keeps its other values", async () => {
        const { repository, post } = buildRepository([buildEvent()]);

        await repository.requestDeletion("event000001", request).toPromise();

        expect(postedValues(post)).toMatchObject({
            [uploadsDHIS2Ids.deletionRequestedBy]: "admin.user",
            [uploadsDHIS2Ids.deletionRequestedAt]: "2026-10-07T10:00:00.000Z",
            [uploadsDHIS2Ids.deletionReason]: "Wrong year",
            [uploadsDHIS2Ids.status]: "UPLOADED",
            [uploadsDHIS2Ids.documentName]: "file.csv",
        });
    });

    it("does not send the deletion data elements for an upload without a deletion request", async () => {
        const { repository, post } = buildRepository([buildEvent()]);

        await repository.setStatus("event000001", "IMPORTED").toPromise();

        const values = postedValues(post);
        expect(values[uploadsDHIS2Ids.status]).toBe("IMPORTED");
        const deletionIds: string[] = [
            uploadsDHIS2Ids.deletionRequestedBy,
            uploadsDHIS2Ids.deletionRequestedAt,
            uploadsDHIS2Ids.deletionReason,
        ];
        expect(Object.keys(values).filter(id => deletionIds.includes(id))).toEqual([]);
    });

    it("reads the uploader and the deletion request from the event", async () => {
        const event = buildEvent({
            dataValues: {
                [uploadsDHIS2Ids.deletionRequestedBy]: "admin.user",
                [uploadsDHIS2Ids.deletionRequestedAt]: "2026-10-07T10:00:00.000Z",
                [uploadsDHIS2Ids.deletionReason]: "Wrong year",
            },
        });
        const { repository } = buildRepository([event]);

        const upload: GlassUploads = await repository.getById("event000001").toPromise();

        expect(upload.uploadedBy).toBe("uploader.user");
        expect(upload.deletionRequest).toEqual(request);
    });

    it("lists only deleted uploads, asking DHIS2 for deleted events in a stable order", async () => {
        const { repository, get } = buildRepository([
            buildEvent({ event: "event000001", deleted: true }),
            buildEvent({ event: "event000002", deleted: false }),
        ]);

        const uploads = await repository.getDeletedUploadsByModuleOU("IVnpk5xiXGG", "countryOu01").toPromise();

        expect(uploads.map(upload => upload.id)).toEqual(["event000001"]);
        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({
                includeDeleted: true,
                order: "createdAt:desc,event:asc",
                orgUnit: "countryOu01",
                filter: `${uploadsDHIS2Ids.moduleId}:eq:IVnpk5xiXGG`,
            })
        );
    });
});
