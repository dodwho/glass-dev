import { d2Functions } from "../d2Functions";
import { executeExpression } from "../executionService";
import { replaceVariablesWithValues } from "../RulesEngine";
import { toStringLiteral, ValueProcessor } from "../ValueProcessor";

// The path a rule takes in RulesEngine: the file values are substituted into the expression as string
// literals, the d2: functions are evaluated, and the result is run as JavaScript.
function evaluateRule(expression: string, values: Record<string, string>): unknown {
    const variablesHash = Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
            name,
            { variableValue: toStringLiteral(value), variablePrefix: "#", variableType: "TEXT", hasValue: true },
        ])
    );
    const variableService = { processValue: (value: unknown) => toStringLiteral(value) };
    const functions = d2Functions({}, variableService, variablesHash, null, []);
    return executeExpression(functions, replaceVariablesWithValues(expression, variablesHash), () => undefined);
}

type GlobalWithFlag = { injected?: unknown };
const globalWithFlag = globalThis as unknown as GlobalWithFlag;

describe("program rule expressions with values from an uploaded file", () => {
    beforeEach(() => {
        delete globalWithFlag.injected;
    });

    it("evaluates ordinary values as before", () => {
        expect(evaluateRule("#{X} == 'Escherichia coli'", { X: "Escherichia coli" })).toBe(true);
        expect(evaluateRule("d2:length(#{X}) > 3", { X: "abcd" })).toBe(true);
        expect(evaluateRule("d2:concatenate(#{X}, 'z') == 'abz'", { X: "ab" })).toBe(true);
    });

    it("keeps apostrophes and backslashes as part of the value", () => {
        expect(evaluateRule('#{X} == "O\'Brien"', { X: "O'Brien" })).toBe(true);
        expect(evaluateRule("d2:length(#{X}) == 3", { X: "a\\b" })).toBe(true);
        expect(evaluateRule("d2:length(#{X}) == 7", { X: "O'Brien" })).toBe(true);
    });

    it.each([
        ["inside a d2: function call", "d2:length(#{X}) > 3", { X: "a') + (globalThis.injected=1) //" }],
        ["through a $ replacement pattern", "#{X} != 'a' && #{X} != 'b'", { X: "+(globalThis.injected=1)//$&" }],
        ["through $` in a value", "'abc' == #{X}", { X: "$`;globalThis.injected=1;//" }],
        ["through d2:concatenate", "d2:concatenate('p', #{X}) == #{Y}", { X: "a\\", Y: "+(globalThis.injected=1)//" }],
        ["through d2:checkControlDigits", "d2:checkControlDigits(#{X})", { X: "(globalThis.injected=1)" }],
        ["through d2:zing", "d2:zing(#{X}) > 0", { X: "(globalThis.injected=1)" }],
    ])("does not run code hidden in a value %s", (_label, expression, values) => {
        evaluateRule(expression, values);
        expect(globalWithFlag.injected).toBeUndefined();
    });

    it("keeps numbers unquoted for d2:zing, as before", () => {
        expect(evaluateRule("d2:zing(#{X}) + 1", { X: "5" })).toBe(6);
        expect(evaluateRule("d2:zing(#{X})", { X: "-3" })).toBe(0);
    });

    it("quotes a value of a type without a converter unless it is a plain number", () => {
        const processor = new ValueProcessor({});
        expect(processor.processValue("0.5", "UNIT_INTERVAL")).toBe("0.5");
        const quoted = processor.processValue("(globalThis.injected=1)", "MULTI_TEXT");
        expect(new Function(`"use strict";return ${quoted}`)()).toBe("(globalThis.injected=1)");
        expect(globalWithFlag.injected).toBeUndefined();
    });
});
