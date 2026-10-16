import { Instance } from "../../entities/Instance";
import { Dhis2EventsDefaultRepository } from "../Dhis2EventsDefaultRepository";

type EventsPage = Awaited<ReturnType<Dhis2EventsDefaultRepository["getEGASPEvents"]>>;

function page(pageNumber: number, count: number): EventsPage {
    const instances = Array.from({ length: count }, (_, i) => ({ event: `p${pageNumber}e${i}` }));
    return { page: pageNumber, pageSize: 250, instances } as unknown as EventsPage;
}

describe("Dhis2EventsDefaultRepository.getEGASPEventsByOrgUnit", () => {
    it("reads every page of the country's EGASP events, not only the first 250", async () => {
        const repository = new Dhis2EventsDefaultRepository(new Instance({ url: "https://dhis2.test" }));
        const pages = [page(1, 250), page(2, 250), page(3, 17)];
        const getEGASPEvents = jest
            .spyOn(repository, "getEGASPEvents")
            .mockImplementation(async (_orgUnit, pageNumber) => pages[pageNumber - 1] ?? page(pageNumber, 0));

        const events = await repository.getEGASPEventsByOrgUnit("UGA").toPromise();

        expect(events).toHaveLength(517);
        expect(getEGASPEvents.mock.calls.map(([orgUnit, pageNumber]) => `${orgUnit}:${pageNumber}`)).toEqual([
            "UGA:1",
            "UGA:2",
            "UGA:3",
        ]);
    });

    it("asks for one more page when the last full page happens to end the list", async () => {
        const repository = new Dhis2EventsDefaultRepository(new Instance({ url: "https://dhis2.test" }));
        const getEGASPEvents = jest
            .spyOn(repository, "getEGASPEvents")
            .mockImplementation(async (_orgUnit, pageNumber) => page(pageNumber, pageNumber === 1 ? 250 : 0));

        const events = await repository.getEGASPEventsByOrgUnit("UGA").toPromise();

        expect(events).toHaveLength(250);
        expect(getEGASPEvents).toHaveBeenCalledTimes(2);
    });
});
