import { Future } from "../../../../entities/Future";
import { TrackerEvent } from "../../../../entities/TrackedEntityInstance";
import {
    AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
    ATC_VERSION_DATA_ELEMENT_ID,
    EGASP_DATAELEMENT_ID,
    EGASP_PROGRAM_ID,
    PATIENT_DATAELEMENT_ID,
} from "../../../../entities/GlassMetadataReferences";
import { EventsRepository } from "../../../../repositories/EventsRepository";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { CustomValidationForEventProgram } from "../CustomValidationForEventProgram";

const country = { id: "UGA", name: "Uganda" };
const clinics = [
    { id: "clinic-kla", name: "Kampala clinic" },
    { id: "clinic-gul", name: "Gulu clinic" },
];

/** A file row: rows from an uploaded template are numbered from 6, the first data row in Excel. */
function event(line: number, values: { egaspId?: string; patient?: string }, overrides: Partial<TrackerEvent> = {}) {
    const dataValues = [
        ...(values.egaspId ? [{ dataElement: EGASP_DATAELEMENT_ID, value: values.egaspId }] : []),
        ...(values.patient ? [{ dataElement: PATIENT_DATAELEMENT_ID, value: values.patient }] : []),
    ];
    return {
        event: String(line),
        program: EGASP_PROGRAM_ID,
        programStage: "",
        orgUnit: "clinic-kla",
        occurredAt: "2025-03-14",
        status: "COMPLETED",
        dataValues,
        ...overrides,
    } as TrackerEvent;
}

function setup(existingEvents: TrackerEvent[] = []) {
    const getEGASPEventsByOrgUnit = jest.fn(() => Future.success(existingEvents));
    const eventsRepository = { getEGASPEventsByOrgUnit } as unknown as EventsRepository;
    const metadataRepository = {
        getClinicsAndLabsInOrgUnitId: () => Future.success(clinics.map(c => c.id)),
        getClinicOrLabNames: (ids: string[]) =>
            Future.success(ids.map(id => ({ id, name: clinics.find(c => c.id === id)?.name ?? `Name of ${id}` }))),
    } as unknown as MetadataRepository;
    const validator = new CustomValidationForEventProgram(eventsRepository, metadataRepository);
    const validate = (events: TrackerEvent[], program = EGASP_PROGRAM_ID, period = "2025") =>
        validator.getValidatedEvents(events, country.id, country.name, period, program).toPromise();
    return { validate, getEGASPEventsByOrgUnit };
}

describe("CustomValidationForEventProgram (EGASP)", () => {
    it("accepts a clean file and checks it against the existing EGASP events of the country", async () => {
        const { validate, getEGASPEventsByOrgUnit } = setup();
        const events = [event(6, { egaspId: "E1", patient: "P1" }), event(7, { egaspId: "E2", patient: "P2" })];

        const result = await validate(events);

        expect(result.blockingErrors).toEqual([]);
        expect(result.events).toBe(events);
        expect(getEGASPEventsByOrgUnit).toHaveBeenCalledWith(country.id);
    });

    it("blocks rows from a clinic that is not in the selected country, naming the clinic", async () => {
        const { validate } = setup();

        const result = await validate([
            event(6, { egaspId: "E1" }, { orgUnit: "clinic-abroad" }),
            event(7, { egaspId: "E2" }),
            event(8, { egaspId: "E3" }, { orgUnit: "clinic-abroad" }),
        ]);

        expect(result.blockingErrors).toEqual([
            {
                error: "Clinics in file, are not part of the selected country: Selected Country : Uganda, Clinic in file: Name of clinic-abroad",
                count: 2,
                lines: [6, 8],
            },
        ]);
    });

    it("blocks rows whose event date is in another year", async () => {
        const { validate } = setup();

        const result = await validate([
            event(6, { egaspId: "E1" }),
            event(7, { egaspId: "E2" }, { occurredAt: "2024-12-31" }),
        ]);

        expect(result.blockingErrors).toEqual([
            {
                error: "Event date is incorrect: Selected period : 2025, date in file: 2024-12-31",
                count: 1,
                lines: [7],
            },
        ]);
    });

    describe("EGASP ID must be unique within a clinic", () => {
        it("blocks the same EGASP ID twice in the file", async () => {
            const { validate } = setup();

            const result = await validate([event(6, { egaspId: "E1" }), event(7, { egaspId: "E1" })]);

            expect(result.blockingErrors).toEqual([
                { error: "This EGASP ID already exists : E1", lines: [6, 7], count: 2 },
            ]);
        });

        it("blocks an EGASP ID that already exists in DHIS2 for the clinic", async () => {
            const existing = event(0, { egaspId: "E1" }, { event: "dhis2EventUid" });
            const { validate } = setup([existing]);

            const result = await validate([event(6, { egaspId: "E1" })]);

            // The existing event's id is not a line number, so only the file line is listed.
            expect(result.blockingErrors).toEqual([
                { error: "This EGASP ID already exists : E1", lines: [6], count: 2 },
            ]);
        });

        it("allows the same EGASP ID in two different clinics", async () => {
            const { validate } = setup([event(0, { egaspId: "E1" }, { event: "uid1", orgUnit: "clinic-gul" })]);

            const result = await validate([event(6, { egaspId: "E1" })]);

            expect(result.blockingErrors).toEqual([]);
        });

        it("does not report duplicates that exist only in DHIS2, not in the file", async () => {
            const { validate } = setup([
                event(0, { egaspId: "E9" }, { event: "uid1" }),
                event(0, { egaspId: "E9" }, { event: "uid2" }),
            ]);

            const result = await validate([event(6, { egaspId: "E1" })]);

            expect(result.blockingErrors).toEqual([]);
        });
    });

    describe("a patient can have one event per date within a clinic", () => {
        const message = (patient: string, isoDate: string) =>
            `This date is already associated to the same Patient-ID. Please check if the current information has already been entered. If not, please check whether the Patient-ID or this date are correct.
                            Patient Id: ${patient}, Event Date: ${isoDate}`;

        it("blocks the same patient and date twice in the file", async () => {
            const { validate } = setup();

            const result = await validate([
                event(6, { egaspId: "E1", patient: "P1" }),
                event(7, { egaspId: "E2", patient: "P1" }),
            ]);

            expect(result.blockingErrors).toEqual([
                { error: message("P1", "2025-03-14T00:00:00.000Z"), lines: [6, 7], count: 2 },
            ]);
        });

        it("blocks a patient and date already in DHIS2 for the clinic", async () => {
            const { validate } = setup([event(0, { egaspId: "E0", patient: "P1" }, { event: "uid1" })]);

            const result = await validate([event(6, { egaspId: "E1", patient: "P1" })]);

            expect(result.blockingErrors).toEqual([
                { error: message("P1", "2025-03-14T00:00:00.000Z"), lines: [6], count: 2 },
            ]);
        });

        it("accepts the same patient on another date", async () => {
            const { validate } = setup();

            const result = await validate([
                event(6, { egaspId: "E1", patient: "P1" }),
                event(7, { egaspId: "E2", patient: "P1" }, { occurredAt: "2025-03-15" }),
            ]);

            expect(result.blockingErrors).toEqual([]);
        });
    });
});

describe("CustomValidationForEventProgram (AMC raw substance consumption)", () => {
    const amcEvent = (line: number, atcVersion?: string) =>
        event(
            line,
            {},
            {
                orgUnit: country.id,
                program: AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
                dataValues: atcVersion ? [{ dataElement: ATC_VERSION_DATA_ELEMENT_ID, value: atcVersion }] : [],
            }
        );

    it("accepts ATC versions as ATC-YYYY-vN or as a plain year, without loading EGASP events", async () => {
        const { validate, getEGASPEventsByOrgUnit } = setup();

        const result = await validate(
            [amcEvent(6, "ATC-2025-v1"), amcEvent(7, "2025")],
            AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID
        );

        expect(result.blockingErrors).toEqual([]);
        expect(getEGASPEventsByOrgUnit).not.toHaveBeenCalled();
    });

    it("checks the country, not clinics, and blocks a missing or malformed ATC version", async () => {
        const { validate } = setup();

        const result = await validate(
            [
                amcEvent(6, "ATC-2025"),
                amcEvent(7),
                event(
                    8,
                    {},
                    { orgUnit: "KEN", dataValues: [{ dataElement: ATC_VERSION_DATA_ELEMENT_ID, value: "2025" }] }
                ),
            ],
            AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID
        );

        expect(result.blockingErrors).toEqual([
            {
                error: "Selected Country is incorrect: Selected country : Uganda, country in file: KEN",
                count: 1,
                lines: [8],
            },
            {
                error: "There is not an ATC version data for the corresponding year in ATC version manual",
                count: 2,
                lines: [6, 7],
            },
        ]);
    });
});
