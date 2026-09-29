import { ProgramRulesMetadataRepository } from "../../../repositories/program-rules/ProgramRulesMetadataRepository";
import { ProgramRuleValidationForBLEventProgram } from "../ProgramRuleValidationForBLEventProgram";

const event = { event: "7", program: "program01", programStage: "stage001", orgUnit: "ou", dataValues: [] };
const program = { id: "program01", programStages: [], programTrackedEntityAttributes: [] };
const metadata = { dataElements: [] };

function getActions(eventEffects: unknown[]) {
    const validation = new ProgramRuleValidationForBLEventProgram({} as ProgramRulesMetadataRepository);
    return (validation as any).getActions(eventEffects, metadata);
}

describe("ProgramRuleValidationForBLEventProgram effects", () => {
    it("keeps the errors and assignments of a batch where a single event has effects", () => {
        const result = getActions([
            {
                program,
                event,
                events: [event],
                orgUnit: { id: "ou" },
                effects: [
                    { type: "SHOWERROR", message: "Not allowed", error: { message: "Not allowed", id: "e1" } },
                    { type: "ASSIGN", id: "dataElem001", targetDataType: "dataElement", value: "X" },
                ],
            },
        ]);

        expect(result.blockingErrors).toEqual([{ error: "Not allowed", count: 1, lines: [7] }]);
        expect(result.actions).toEqual([
            expect.objectContaining({
                type: "event",
                eventId: "7",
                value: "X",
                dataElement: { id: "dataElem001", name: "-" },
            }),
        ]);
    });

    it("reports each event once when several events have effects", () => {
        const effect = { type: "SHOWERROR", message: "Not allowed", error: { message: "Not allowed", id: "e1" } };
        const eventEffect = (id: string) => ({
            program,
            event: { ...event, event: id },
            events: [],
            orgUnit: {},
            effects: [effect],
        });

        const result = getActions([eventEffect("2"), eventEffect("3"), eventEffect("4")]);

        expect(result.blockingErrors).toEqual([{ error: "Not allowed", count: 3, lines: [2, 3, 4] }]);
    });
});
