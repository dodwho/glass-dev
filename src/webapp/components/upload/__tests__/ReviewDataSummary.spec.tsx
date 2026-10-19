import { vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Future } from "../../../../domain/entities/Future";
import { GlassUploadsStatus } from "../../../../domain/entities/GlassUploads";
import { ImportSummary } from "../../../../domain/entities/data-entry/ImportSummary";
import { AppContext, AppContextState } from "../../../contexts/app-context";
import { CurrentModuleContext, defaultModuleContextState } from "../../../contexts/current-module-context";
import { ReviewDataSummary } from "../ReviewDataSummary";

/*
 * The summary step (step 3) after the real import. An upload with errors found after saving (IMPORTED) must not be
 * completed: the screen shows the errors and disables Continue, and Continue completes only a VALIDATED upload.
 */

const snackbar = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() };

vi.mock("@eyeseetea/d2-ui-components", async importOriginal => ({
    ...(await importOriginal<typeof import("@eyeseetea/d2-ui-components")>()),
    useSnackbar: () => snackbar,
}));
vi.mock("../../../hooks/useCurrentDataSubmissionId", () => ({ useCurrentDataSubmissionId: () => "submission-1" }));
vi.mock("../../../hooks/useCurrentUserGroupsAccess", () => ({
    useCurrentUserGroupsAccess: () => ({ captureAccessGroup: { kind: "loading" } }),
}));
vi.mock("../../../hooks/useGetLastSuccessfulAnalyticsRunTime", () => ({
    useGetLastSuccessfulAnalyticsRunTime: () => ({
        lastSuccessfulAnalyticsRunTime: { kind: "loading" },
        setRefetch: () => {},
    }),
}));
vi.mock("../../current-data-submission/Questionnaires", () => ({ useQuestionnaires: () => [[]] }));
vi.mock("../../current-data-submission/Validations", () => ({ Validations: () => null }));

const summary = (overrides: Partial<ImportSummary> = {}): ImportSummary => ({
    status: "SUCCESS",
    importCount: { imported: 10, updated: 0, ignored: 0, deleted: 0, total: 10 },
    nonBlockingErrors: [],
    blockingErrors: [],
    ...overrides,
});

function renderStep(options: {
    importSummary: ImportSummary;
    secondaryImportSummary?: ImportSummary;
    uploadStatus: GlassUploadsStatus;
}) {
    const setStatus = vi.fn((_params: { id: string; status: GlassUploadsStatus }) => Future.success(undefined));
    const changeStep = vi.fn();
    const compositionRoot = {
        glassUploads: {
            getById: (id: string) => Future.success({ id, status: options.uploadStatus }),
            setStatus,
        },
        glassDataSubmission: { setStatus: () => Future.success(undefined) },
        notifications: { send: () => Future.success(undefined) },
    };
    const context = {
        compositionRoot,
        currentUser: { id: "user-1", username: "tester" },
    } as unknown as AppContextState;

    // AMR aggregate has a RIS (primary) and a SAMPLE (secondary) file, shown in two tabs.
    const moduleContext = {
        ...defaultModuleContextState,
        currentModuleAccess: {
            ...defaultModuleContextState.currentModuleAccess,
            moduleId: "AVnpk4xiXGG",
            moduleName: "AMR",
        },
    };

    localStorage.setItem("primaryUploadId", "upload-1");
    render(
        <AppContext.Provider value={context}>
            <CurrentModuleContext.Provider value={moduleContext}>
                <ReviewDataSummary
                    changeStep={changeStep}
                    primaryFileImportSummary={options.importSummary}
                    secondaryFileImportSummary={options.secondaryImportSummary}
                    isRunningCalculation={false}
                    primaryFile={new File(["x"], "file.csv")}
                />
            </CurrentModuleContext.Provider>
        </AppContext.Provider>
    );
    const continueButton = () => screen.getByRole("button", { name: /continue/i });
    return { setStatus, changeStep, continueButton };
}

const blockingError = { error: "Validation rule 'R1' violated", count: 2, lines: [3, 7] };

describe("ReviewDataSummary (summary step)", () => {
    beforeEach(() => {
        snackbar.error.mockReset();
    });

    it("shows the errors DHIS2 reported after saving, says the data was saved, and disables Continue", () => {
        const { continueButton } = renderStep({
            importSummary: summary({ status: "ERROR", blockingErrors: [blockingError] }),
            uploadStatus: "IMPORTED",
        });

        expect(screen.getByText("Errors found after the import")).toBeTruthy();
        expect(screen.getByText(/The data of this file was saved in DHIS2/)).toBeTruthy();
        expect(screen.getByText("Validation rule 'R1' violated")).toBeTruthy();
        expect(continueButton().hasAttribute("disabled")).toBe(true);
    });

    it("does not say the data was saved when nothing was imported", () => {
        renderStep({
            importSummary: summary({
                status: "ERROR",
                blockingErrors: [blockingError],
                importCount: { imported: 0, updated: 0, ignored: 3, deleted: 0, total: 3 },
            }),
            uploadStatus: "IMPORTED",
        });

        expect(screen.queryByText(/The data of this file was saved in DHIS2/)).toBeNull();
        expect(screen.getByText(/DHIS2 reported the errors below/)).toBeTruthy();
    });

    it("completes a VALIDATED upload and moves to the last step", async () => {
        const { continueButton, setStatus, changeStep } = renderStep({
            importSummary: summary(),
            uploadStatus: "VALIDATED",
        });

        expect(screen.queryByText("Errors found after the import")).toBeNull();
        await userEvent.click(continueButton());

        await waitFor(() => expect(changeStep).toHaveBeenCalledWith(4));
        expect(setStatus).toHaveBeenCalledWith({ id: "upload-1", status: "COMPLETED" });
    });

    // The summary shows no error but the upload is not VALIDATED (for example the AMC calculation failed).
    it("refuses to complete an upload that is not VALIDATED, with a message, and stays on the step", async () => {
        const { continueButton, setStatus, changeStep } = renderStep({
            importSummary: summary(),
            uploadStatus: "IMPORTED",
        });

        await userEvent.click(continueButton());

        await waitFor(() => expect(snackbar.error).toHaveBeenCalledTimes(1));
        expect(snackbar.error.mock.calls[0]?.[0]).toMatch(/cannot be completed/);
        expect(setStatus).not.toHaveBeenCalled();
        expect(changeStep).not.toHaveBeenCalled();
    });

    // Users used to see only the open tab (RIS) and had to click SAMPLE to find out that it had errors.
    it("tells the user on the RIS tab that the SAMPLE file has errors, and shows them when asked", async () => {
        const { continueButton } = renderStep({
            importSummary: summary(),
            secondaryImportSummary: summary({ status: "ERROR", blockingErrors: [blockingError] }),
            uploadStatus: "IMPORTED",
        });

        expect(screen.getByText(/The SAMPLE file has errors/)).toBeTruthy();
        expect(screen.queryByText("Errors found after the import")).toBeNull();
        expect(continueButton().hasAttribute("disabled")).toBe(true);

        await userEvent.click(screen.getByRole("button", { name: "Show the SAMPLE file errors" }));

        expect(screen.getByText("Errors found after the import")).toBeTruthy();
        expect(screen.getByText("Validation rule 'R1' violated")).toBeTruthy();
        expect(screen.queryByText(/The SAMPLE file has errors/)).toBeNull();
    });

    it("tells the user on the SAMPLE tab that the RIS file has errors", async () => {
        renderStep({
            importSummary: summary({ status: "ERROR", blockingErrors: [blockingError] }),
            secondaryImportSummary: summary(),
            uploadStatus: "IMPORTED",
        });
        await userEvent.click(screen.getByRole("button", { name: "SAMPLE File" }));

        expect(screen.getByText(/The RIS file has errors/)).toBeTruthy();
        expect(screen.queryByText("Errors found after the import")).toBeNull();
    });

    it("shows no notice when the open tab is the one with the errors, or when neither has", () => {
        renderStep({
            importSummary: summary({ status: "ERROR", blockingErrors: [blockingError] }),
            secondaryImportSummary: summary(),
            uploadStatus: "IMPORTED",
        });
        expect(screen.getByText("Errors found after the import")).toBeTruthy();
        expect(screen.queryByText(/file has errors/)).toBeNull();
    });
});
