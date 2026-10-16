import _ from "lodash";
import { ConsistencyError } from "../../../entities/data-entry/ImportSummary";

/** One error per message, with every file line it occurred on, counting each line once. */
export function groupLineErrors(errors: { error: string; line: number }[]): ConsistencyError[] {
    return _(errors)
        .groupBy(({ error }) => error)
        .map((group, error) => {
            const lines = _.uniq(group.map(({ line }) => line));
            return { error, count: lines.length, lines };
        })
        .value();
}
