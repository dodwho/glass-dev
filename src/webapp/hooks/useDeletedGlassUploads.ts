import React from "react";
import { CompositionRoot } from "../../CompositionRoot";
import { useCurrentModuleContext } from "../contexts/current-module-context";
import { useCurrentOrgUnitContext } from "../contexts/current-orgUnit-context";
import { GlassUploadsState } from "./useGlassUploads";

export function useDeletedGlassUploads(compositionRoot: CompositionRoot) {
    const {
        currentModuleAccess: { moduleId },
    } = useCurrentModuleContext();
    const {
        currentOrgUnitAccess: { orgUnitId },
    } = useCurrentOrgUnitContext();

    const [uploads, setUploads] = React.useState<GlassUploadsState>({ kind: "loading" });

    React.useEffect(() => {
        compositionRoot.glassUploads.getDeletedByModuleOU(moduleId, orgUnitId).run(
            uploads => setUploads({ kind: "loaded", data: uploads }),
            error => setUploads({ kind: "error", message: error })
        );
    }, [compositionRoot, moduleId, orgUnitId]);

    return uploads;
}
