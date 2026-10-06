import { toStringLiteral, ValueProcessor } from "../ValueProcessor";

// The same way executionService runs an expression.
function evaluate(code: string): unknown {
    return new Function(`"use strict";return ${code}`)();
}

describe("toStringLiteral", () => {
    it("keeps ordinary values unchanged", () => {
        expect(evaluate(toStringLiteral("Escherichia coli"))).toBe("Escherichia coli");
    });

    it("keeps apostrophes, backslashes and line breaks as part of the value", () => {
        const value = "it's a\\b\nc\rd";
        expect(evaluate(toStringLiteral(value))).toBe(value);
    });

    it("does not run code hidden in a value", () => {
        const globalWithFlag = globalThis as unknown as { injected?: boolean };
        delete globalWithFlag.injected;

        const malicious = "x'+(globalThis.injected=true)+'";

        expect(evaluate(toStringLiteral(malicious))).toBe(malicious);
        expect(globalWithFlag.injected).toBeUndefined();
    });
});

describe("ValueProcessor.addQuotesToValueIfString", () => {
    it("escapes strings and leaves other types alone", () => {
        expect(ValueProcessor.addQuotesToValueIfString("a'b")).toBe("'a\\'b'");
        expect(ValueProcessor.addQuotesToValueIfString(5)).toBe(5);
    });
});
