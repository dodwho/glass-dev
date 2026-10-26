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
 * the file for real and marks the upload VALIDATED (no errors) or IMPORTED (errors DHIS2 found after saving). The upload
 * is marked IMPORTED before the real import starts, so an import that stops part-way never leaves stored data behind an
 * upload that says UPLOADED (Norway 2024 on PROD).
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
    secondaryDryRunSummary?: ImportSummary;
    realImport?: FutureData<ImportSummary>;
    /** With a SAMPLE file: what its real import reports. */
    secondaryRealImport?: ImportSummary;
    setStatusFails?: boolean;
};

function renderStep(options: Options) {
    const {
        dryRunSummary,
        secondaryDryRunSummary,
        realImport = Future.success<ImportSummary, string>(summary()),
        secondaryRealImport,
        setStatusFails = false,
    } = options;
    const primaryFile = vi.fn((..._args: unknown[]) => realImport);
    const setStatus = vi.fn((_params: { id: string; status: GlassUploadsStatus }) =>
        setStatusFails ? Future.error<string, void>("network error") : Future.success<void, string>(undefined)
    );
    const saveImportSummaryErrorsOfFiles = vi.fn((_params: unknown) => Future.success(undefined));
    const deletePrimaryFile = vi.fn((..._args: unknown[]) => Future.success<ImportSummary, string>(summary()));
    const changeStep = vi.fn();
    const context = {
        compositionRoot: {
            fileSubmission: {
                primaryFile,
                secondaryFile: () => Future.success(secondaryRealImport),
                deletePrimaryFile,
            },
            glassUploads: {
                setStatus,
                saveImportSummaryErrorsOfFiles,
                getById: (id: string) => Future.success({ id, status: "IMPORTED" }),
            },
            glassModules: { getByName: () => Future.success({ name: "AMR" }) },
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
        const [secondarySummary, setSecondarySummary] = useState<ImportSummary | undefined>(secondaryDryRunSummary);
        return (
            <ConsistencyChecks
                changeStep={changeStep}
                batchId="DS1"
                primaryFile={new File(["x"], "ris.csv")}
                secondaryFile={secondaryRealImport ? new File(["x"], "sample.csv") : null}
                primaryFileImportSummary={primarySummary}
                secondaryFileImportSummary={secondarySummary}
                setPrimaryFileImportSummary={setPrimarySummary}
                setSecondaryFileImportSummary={setSecondarySummary}
                setIsRunningCalculation={() => {}}
            />
        );
    };

    localStorage.setItem("primaryUploadId", "upload-1");
    if (secondaryRealImport) localStorage.setItem("secondaryUploadId", "upload-2");
    else localStorage.removeItem("secondaryUploadId");
    render(
        <AppContext.Provider value={context}>
            <CurrentModuleContext.Provider value={moduleContext}>
                <Step />
            </CurrentModuleContext.Provider>
        </AppContext.Provider>
    );
    const continueButton = () => screen.getByRole("button", { name: /continue/i });
    return { continueButton, primaryFile, setStatus, saveImportSummaryErrorsOfFiles, deletePrimaryFile, changeStep };
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

    // RIS and SAMPLE are one batch: the app used to judge only the RIS file, so a SAMPLE file with errors was completed.
    it("keeps both uploads IMPORTED when only the SAMPLE import reports errors", async () => {
        const { continueButton, setStatus, changeStep } = renderStep({
            dryRunSummary: summary(),
            secondaryRealImport: summary({ status: "ERROR", blockingErrors: [blockingError] }),
        });

        await userEvent.click(continueButton());

        await waitFor(() => expect(changeStep).toHaveBeenCalledWith(3));
        expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "VALIDATED" }));
        expect(setStatus).toHaveBeenCalledWith({ id: "upload-1", status: "IMPORTED" });
        expect(setStatus).toHaveBeenCalledWith({ id: "upload-2", status: "IMPORTED" });
    });

    it("removes what the import wrote, keeps the upload IMPORTED and stays on the step when the import fails", async () => {
        const { continueButton, setStatus, deletePrimaryFile, changeStep } = renderStep({
            dryRunSummary: summary(),
            realImport: Future.error<string, ImportSummary>("DHIS2 could not be reached"),
        });

        await userEvent.click(continueButton());

        // The message says what to do and carries DHIS2's reason.
        await waitFor(() =>
            expect(screen.getByText(/some data may have been saved.*\(DHIS2 could not be reached\)/)).toBeTruthy()
        );
        expect(deletePrimaryFile).toHaveBeenCalledTimes(1);
        // IMPORTED before the import, and never set back: DHIS2 can still write the import after the app gave up
        expect(setStatus.mock.calls.map(([params]) => params)).toEqual([{ id: "upload-1", status: "IMPORTED" }]);
        expect(changeStep).not.toHaveBeenCalled();
    });

    it("does not start the import when the upload cannot be marked IMPORTED, and stays on the step", async () => {
        const { continueButton, primaryFile, changeStep } = renderStep({
            dryRunSummary: summary(),
            setStatusFails: true,
        });

        await userEvent.click(continueButton());

        // The message carries DHIS2's reason.
        await waitFor(() => expect(screen.getByText(/nothing was saved.*\(network error\)/)).toBeTruthy());
        expect(primaryFile).not.toHaveBeenCalled();
        expect(changeStep).not.toHaveBeenCalled();
    });

    // Users used to see only the open tab (RIS) and had to click SAMPLE to find out that it had errors.
    it("tells the user on the RIS tab that the SAMPLE file has errors, and shows them when asked", async () => {
        renderStep({
            dryRunSummary: summary(),
            secondaryDryRunSummary: summary({ status: "ERROR", blockingErrors: [blockingError] }),
        });

        expect(screen.getByText(/The SAMPLE file has errors/)).toBeTruthy();
        expect(screen.queryByText("Validation rule 'R1' violated")).toBeNull();

        await userEvent.click(screen.getByRole("button", { name: "Show the SAMPLE file errors" }));

        expect(screen.getByText("Validation rule 'R1' violated")).toBeTruthy();
        expect(screen.queryByText(/The SAMPLE file has errors/)).toBeNull();
    });

    it("shows no notice when the open tab is the one with the errors", () => {
        renderStep({
            dryRunSummary: summary({ status: "ERROR", blockingErrors: [blockingError] }),
            secondaryDryRunSummary: summary(),
        });

        expect(screen.getByText("Validation rule 'R1' violated")).toBeTruthy();
        expect(screen.queryByText(/file has errors/)).toBeNull();
    });
});
