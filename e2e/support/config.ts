/** Yearly modules open the previous calendar year by default, so the tests use that year. */
export const testYear = String(new Date().getFullYear() - 1);

/** Every test file name starts with this, so the tests only ever touch their own uploads. */
export const fileMarker = "E2E_TEST";

export const port = 8099;
export const dhis2Url = `http://localhost:${port}/dhis2`;

/* Test countries on DEV, enrolled in the module and with no data for the test year. The Republic of Korea is
   enrolled in every module; EGASP data must be reported by clinics, and Korea has none, so EGASP uses Uganda. */
const korea = { id: "IbGbsybdeou", code: "KOR" };
const uganda = { id: "SnYHrnchKjL", code: "UGA" };

export const modules = {
    AMR: { id: "AVnpk4xiXGG", name: "AMR", country: korea },
    AMR_INDIVIDUAL: { id: "IVnpk5xiXGG", name: "AMR - Individual", country: korea, stage: "KCmWZD8qoAk" },
    AMR_FUNGAL: { id: "FVnpk6xiXGG", name: "AMR - Fungal", country: korea, stage: "ysGSonDq9Bc" },
    AMC: { id: "BVnik5xiXGJ", name: "AMC", country: korea },
    EGASP: { id: "CVVp44xiXGJ", name: "EGASP", country: uganda },
} as const;

export type ModuleKey = keyof typeof modules;
