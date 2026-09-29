import fs from "node:fs";
import path from "node:path";
import { Id } from "../../domain/entities/Ref";
import { ChangeCounts } from "./recordingRepositories";

/**
 * Per-run audit trail: one CSV row per org unit/period, appended SYNCHRONOUSLY as each pair
 * finishes. Nothing is buffered, so a run killed with Ctrl+C (or a closed terminal) still leaves a
 * complete record of everything processed up to that point — the same durability the AMU bulk upload
 * report relies on.
 *
 * This is the authoritative "how did the run go" report: the console log is for watching progress,
 * this is for answering afterwards which countries changed and by how much.
 */

export type PairOutcome = "PROCESSED" | "NO_DATA" | "FAILED";

export type AuditRow = {
    orgUnitId: Id;
    period: string;
    outcome: PairOutcome;
    durationSeconds: number;
    hadProductData: boolean;
    hadSubstanceData: boolean;
    productLevel: ChangeCounts;
    substanceLevel: ChangeCounts;
    reason?: string;
};

const HEADER =
    "timestamp,orgUnitId,period,outcome,durationSeconds,hadProductData,hadSubstanceData," +
    "productUpdated,productCreated,productDeleted," +
    "substanceUpdated,substanceCreated,substanceDeleted,totalWritten,reason\n";

function csvField(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

export class AmcRecalculateAudit {
    private readonly rows: AuditRow[] = [];

    constructor(readonly filePath: string) {
        fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
        fs.writeFileSync(filePath, HEADER, "utf8");
    }

    record(row: AuditRow): void {
        this.rows.push(row);

        const totalWritten =
            row.productLevel.updates +
            row.productLevel.creates +
            row.productLevel.deletes +
            row.substanceLevel.updates +
            row.substanceLevel.creates +
            row.substanceLevel.deletes;

        const fields = [
            new Date().toISOString(),
            row.orgUnitId,
            row.period,
            row.outcome,
            row.durationSeconds.toFixed(1),
            String(row.hadProductData),
            String(row.hadSubstanceData),
            String(row.productLevel.updates),
            String(row.productLevel.creates),
            String(row.productLevel.deletes),
            String(row.substanceLevel.updates),
            String(row.substanceLevel.creates),
            String(row.substanceLevel.deletes),
            String(totalWritten),
            row.reason ?? "",
        ];

        fs.appendFileSync(this.filePath, `${fields.map(csvField).join(",")}\n`, "utf8");
    }

    /** A few lines a human can read at the end of a multi-hour run. */
    summarise(): string[] {
        const processed = this.rows.filter(row => row.outcome === "PROCESSED");
        const noData = this.rows.filter(row => row.outcome === "NO_DATA");
        const failed = this.rows.filter(row => row.outcome === "FAILED");

        const total = (counts: (row: AuditRow) => ChangeCounts, key: keyof ChangeCounts) =>
            this.rows.reduce((sum, row) => sum + counts(row)[key], 0);

        const deletes = total(row => row.productLevel, "deletes") + total(row => row.substanceLevel, "deletes");
        const bothLevels = this.rows.filter(row => row.hadProductData && row.hadSubstanceData);

        const lines = [
            `Pairs: ${this.rows.length} (${processed.length} with data, ${noData.length} empty, ${failed.length} failed)`,
            `Product level  : ${total(row => row.productLevel, "updates")} updated, ${total(
                row => row.productLevel,
                "creates"
            )} created, ${total(row => row.productLevel, "deletes")} deleted`,
            `Substance level: ${total(row => row.substanceLevel, "updates")} updated, ${total(
                row => row.substanceLevel,
                "creates"
            )} created, ${total(row => row.substanceLevel, "deletes")} deleted`,
        ];

        if (deletes > 0) {
            lines.push(
                `WARNING: ${deletes} event(s) were deleted. Check the productDeleted/substanceDeleted columns and confirm each is intended.`
            );
        }
        if (bothLevels.length > 0) {
            lines.push(
                `WARNING: ${bothLevels.length} pair(s) hold BOTH product and substance data: ${bothLevels
                    .map(row => `${row.orgUnitId}/${row.period}`)
                    .join(", ")}`
            );
        }
        if (failed.length > 0) {
            lines.push(
                `FAILED pairs (rerun with the same --checkpoint to retry only these): ${failed
                    .map(row => `${row.orgUnitId}/${row.period}`)
                    .join(", ")}`
            );
        }

        lines.push(`Audit report: ${this.filePath}`);
        return lines;
    }
}
