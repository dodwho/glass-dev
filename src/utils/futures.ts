import { CancelableResponse } from "@eyeseetea/d2-api/repositories/CancelableResponse";
import { Future, FutureData } from "../domain/entities/Future";

export function apiToFuture<Data>(res: CancelableResponse<Data>): FutureData<Data> {
    return Future.fromComputation((resolve, reject) => {
        res.getData()
            .then(resolve)
            .catch(err => {
                const message = err?.response?.data?.message || err?.message || "Unknown error";
                // Never log the request itself: its headers carry the credentials or access token.
                const code = err?.code ?? err?.cause?.code;
                console.error(
                    `API request failed: ${err?.request?.method ?? ""} ${err?.request?.url ?? ""} status=${
                        err?.response?.status ?? "none"
                    }${code ? ` code=${code}` : ""}: ${message}`
                );
                reject(message);
            });
        return res.cancel;
    });
}
