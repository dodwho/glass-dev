import { useState } from "react";
import { vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Future, FutureData } from "../../../../domain/entities/Future";
import { GlassUploadsStatus } from "../../../../domain/entities/GlassUploads";
import { ImportSummary } from "../../../../domain/entities/data-entry/ImportSummary";
import { AppContext, AppContextState } from "../../../contexts/app-context";
import { CurrentModuleContext, defaultModuleContextState } from "../../../contexts/current-module-context";
import { ConsistencyChecks } from "../ConsistencyChecks";

/*
 * The consistency checks step (step 2) of an AMR aggregate upload. It shows the dry-run result; its Continue imports
 * the file for real and marks the upload VALIDATED (no errors) or IMPORTED (errors DHIS2 found after saving).
 */

const snackbar = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() };

vi.mock("@eyeseetea/d2-ui-components", async importOriginal => ({
    ...(await importOriginal<typeof import("@eyeseetea/d2-ui-components")>()),
    useSnackbar: () => snackbar,
}));

const summary = (overrides: Partial<ImportSummary> = {}): ImportSummary => ({
    status: "SUCCESS",
    importCount: { imported: 10, updated: 0, ignored: 0, deleted: 0, total: 10 },
    nonBlockingErrors: [],
    blockingErrors: [],
    ...overrides,
});

const blockingError = { error: "Validation rule 'R1' violated", count: 2, lines: [3, 7] };

type Options = {
    dryRunSummary: ImportSummary;
    realImport?: FutureData<ImportSummary>;
    setStatusFails?: boolean;
};

function renderStep(options: Options) {
    const {
        dryRunSummary,
        realImport = Future.success<ImportSummary, string>(summary()),
        setStatusFails = false,
    } = options;
    const primaryFile = vi.fn((..._args: unknown[]) => realImport);
    const setStatus = vi.fn((_params: { id: string; status: GlassUploadsStatus }) =>
        setStatusFails ? Future.error<string, void>("network error") : Future.success<void, string>(undefined)
    );
    const saveImportSummaryErrorsOfFiles = vi.fn((_params: unknown) => Future.success(undefined));
    const changeStep = vi.fn();
    const context = {
        compositionRoot: {
            fileSubmission: { primaryFile, secondaryFile: () => Future.success(undefined) },
            glassUploads: { setStatus, saveImportSummaryErrorsOfFiles },
        },
        allCountries: [],
    } as unknown as AppContextState;
    const moduleContext = {
        ...defaultModuleContextState,
        currentModuleAccess: {
            ...defaultModuleContextState.currentModuleAccess,
            moduleId: "AVnpk4xiXGG",
            moduleName: "AMR",
        },
    };

    const Step = () => {
        const [primarySummary, setPrimarySummary] = useState<ImportSummary | undefined>(dryRunSummary);
        const [secondarySummary, setSecondarySummary] = useState<ImportSummary | undefined>(undefined);
        return (
            <ConsistencyChecks
                changeStep={changeStep}
                batchId="DS1"
                primaryFile={new File(["x"], "ris.csv")}
                primaryFileImportSummary={primarySummary}
                secondaryFileImportSummary={secondarySummary}
                setPrimaryFileImportSummary={setPrimarySummary}
                setSecondaryFileImportSummary={setSecondarySummary}
                setIsRunningCalculation={() => {}}
            />
        );
    };

    localStorage.setItem("primaryUploadId", "upload-1");
    localStorage.removeItem("secondaryUploadId");
    render(
        <AppContext.Provider value={context}>
            <CurrentModuleContext.Provider value={moduleContext}>
                <Step />
            </CurrentModuleContext.Provider>
        </AppContext.Provider>
    );
    const continueButton = () => screen.getByRole("button", { name: /continue/i });
    return { continueButton, primaryFile, setStatus, saveImportSummaryErrorsOfFiles, changeStep };
}

describe("ConsistencyChecks (consistency checks step)", () => {
    beforeEach(() => {
        snackbar.error.mockReset();
    });

    it("shows the blocking errors of the dry run and does not let the import go on", () => {
        const { continueButton, primaryFile } = renderStep({
            dryRunSummary: summary({ status: "ERROR", blockingErrors: [blockingError] }),
        });

        expect(screen.getByText("Validation rule 'R1' violated")).toBeTruthy();
        expect(continueButton().hasAttribute("disabled")).toBe(true);
        expect(primaryFile).not.toHaveBeenCalled();
    });

    it("imports the file for real and marks the upload VALIDATED when DHIS2 reports no error", async () => {
        const { continueButton, primaryFile, setStatus, changeStep } = renderStep({ dryRunSummary: summary() });

        await userEvent.click(continueButton());

        await waitFor(() => expect(changeStep).toHaveBeenCalledWith(3));
        expect(primaryFile).toHaveBeenCalledTimes(1);
        // Arguments: module, file, batch, period, action, org unit id, name, code, dry run, ...
        expect(primaryFile.mock.calls[0]?.[0]).toBe("AMR");
        expect(primaryFile.mock.calls[0]?.[4]).toBe("CREATE_AND_UPDATE");
        expect(primaryFile.mock.calls[0]?.[8]).toBe(false);
        expect(setStatus).toHaveBeenCalledWith({ id: "upload-1", status: "VALIDATED" });
    });

    it("marks the upload IMPORTED, and saves the errors with it, when DHIS2 reports errors after saving", async () => {
        const { continueButton, setStatus, saveImportSummaryErrorsOfFiles, changeStep } = renderStep({
            dryRunSummary: summary(),
            realImport: Future.success(summary({ status: "ERROR", blockingErrors: [blockingError] })),
        });

        await userEvent.click(continueButton());

        await waitFor(() => expect(changeStep).toHaveBeenCalledWith(3));
        expect(setStatus).toHaveBeenCalledWith({ id: "upload-1", status: "IMPORTED" });
        expect(saveImportSummaryErrorsOfFiles).toHaveBeenCalledWith(
            expect.objectContaining({
                primaryUploadId: "upload-1",
                primaryImportSummaryErrors: { nonBlockingErrors: [], blockingErrors: [blockingError] },
            })
        );
    });

    it("shows the error and stays on the step when the import itself fails", async () => {
        const { continueButton, setStatus, changeStep } = renderStep({
            dryRunSummary: summary(),
            realImport: Future.error<string, ImportSummary>("DHIS2 could not be reached"),
        });

        await userEvent.click(continueButton());

        await waitFor(() => expect(screen.getByText("DHIS2 could not be reached")).toBeTruthy());
        expect(setStatus).not.toHaveBeenCalled();
        expect(changeStep).not.toHaveBeenCalled();
    });

    it("tells the user when the upload status cannot be saved, and stays on the step", async () => {
        const { continueButton, changeStep } = renderStep({ dryRunSummary: summary(), setStatusFails: true });

        await userEvent.click(continueButton());

        // The message carries DHIS2's reason.
        await waitFor(() => expect(snackbar.error).toHaveBeenCalledWith("Failed to set upload status: network error"));
        expect(changeStep).not.toHaveBeenCalled();
    });
});
