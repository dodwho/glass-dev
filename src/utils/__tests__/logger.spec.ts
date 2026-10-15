import { vi, type Mock } from "vitest";
import { initLogger } from "@eyeseetea/d2-logger";
import { Instance } from "../../data/entities/Instance";
import { logger, setupLogger } from "../logger";

vi.mock("@eyeseetea/d2-logger", () => ({ initLogger: vi.fn() }));

const mockedInitLogger = initLogger as Mock;

describe("setupLogger", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        mockedInitLogger.mockReset();
    });

    it("reports a failed write to the logs program instead of rejecting", async () => {
        const failingWrite = () => Promise.reject(new Error("409 Conflict"));
        mockedInitLogger.mockResolvedValue({ info: failingWrite, error: failingWrite, batchLog: failingWrite });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await setupLogger(new Instance({ url: "https://dhis2.test", username: "user", password: "pass" }));

        await expect(logger.info("message")).resolves.toBeUndefined();
        await expect(logger.error("message")).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalledTimes(2);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("409 Conflict"));
    });

    it("passes a token as d2-api token auth and basic credentials as basic auth", async () => {
        mockedInitLogger.mockResolvedValue({});

        await setupLogger(new Instance({ url: "https://dhis2.test", token: "d2p_test" }));
        await setupLogger(new Instance({ url: "https://dhis2.test", username: "user", password: "pass" }));

        expect(mockedInitLogger.mock.calls.map(([config]) => config.d2ApiOptions)).toEqual([
            { baseUrl: "https://dhis2.test", auth: { type: "personalToken", token: "d2p_test" } },
            { baseUrl: "https://dhis2.test", auth: { username: "user", password: "pass" } },
        ]);
    });
});
