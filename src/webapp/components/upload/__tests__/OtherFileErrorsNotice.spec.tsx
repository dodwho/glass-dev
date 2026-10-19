import { vi } from "vitest";
import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { ImportSummary } from "../../../../domain/entities/data-entry/ImportSummary";
import { OtherFileErrorsNotice } from "../OtherFileErrorsNotice";

/*
 * The upload steps show one file at a time (RIS or SAMPLE tab). When the file that is not open has blocking errors,
 * this notice tells the user at once and opens it. (The screens that use it have component tests on the upgrade branch.)
 */

const summary = (blockingErrors: ImportSummary["blockingErrors"] = []): ImportSummary => ({
    status: "SUCCESS",
    importCount: { imported: 10, updated: 0, ignored: 0, deleted: 0, total: 10 },
    nonBlockingErrors: [],
    blockingErrors,
});

const withErrors = summary([{ error: "Validation rule 'R1' violated", count: 2, lines: [3, 7] }]);

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
});

afterEach(() => {
    ReactDOM.unmountComponentAtNode(container);
    container.remove();
});

function renderNotice(props: Partial<React.ComponentProps<typeof OtherFileErrorsNotice>>) {
    const onShow = vi.fn();
    act(() => {
        ReactDOM.render(
            <OtherFileErrorsNotice moduleName="AMR" openTab="primary" onShow={onShow} {...props} />,
            container
        );
    });
    return { onShow };
}

describe("OtherFileErrorsNotice", () => {
    it("names the SAMPLE file when it has errors and the RIS tab is open, and opens it on click", () => {
        const { onShow } = renderNotice({
            openTab: "primary",
            primaryFileImportSummary: summary(),
            secondaryFileImportSummary: withErrors,
        });

        expect(container.textContent).toContain("The SAMPLE file has errors");
        const button = container.querySelector("button");
        expect(button?.textContent).toBe("Show the SAMPLE file errors");

        act(() => {
            button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onShow).toHaveBeenCalledWith("secondary");
    });

    it("names the RIS file when it has errors and the SAMPLE tab is open", () => {
        const { onShow } = renderNotice({
            openTab: "secondary",
            primaryFileImportSummary: withErrors,
            secondaryFileImportSummary: summary(),
        });

        expect(container.textContent).toContain("The RIS file has errors");
        act(() => {
            container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onShow).toHaveBeenCalledWith("primary");
    });

    it("shows nothing when the open tab is the one with the errors", () => {
        renderNotice({
            openTab: "primary",
            primaryFileImportSummary: withErrors,
            secondaryFileImportSummary: summary(),
        });

        expect(container.textContent).toBe("");
    });

    it("shows nothing when the other file has only warnings, has no summary, or neither file has errors", () => {
        const warningsOnly: ImportSummary = { ...summary(), nonBlockingErrors: [{ error: "A warning", count: 1 }] };

        renderNotice({ primaryFileImportSummary: summary(), secondaryFileImportSummary: warningsOnly });
        expect(container.textContent).toBe("");

        renderNotice({ primaryFileImportSummary: summary(), secondaryFileImportSummary: undefined });
        expect(container.textContent).toBe("");

        renderNotice({ primaryFileImportSummary: summary(), secondaryFileImportSummary: summary() });
        expect(container.textContent).toBe("");
    });
});
