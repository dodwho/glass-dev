import { useSnackbar } from "@eyeseetea/d2-ui-components";
import i18n from "@eyeseetea/d2-ui-components/locales";
import { CircularProgress } from "material-ui";
import React, { ReactNode, useEffect } from "react";

type loadingStatus = "loading" | "error" | "loaded";

export interface ContentLoaderValue {
    kind: loadingStatus;
    message?: string;
    data?: unknown;
}

export interface ContentLoaderProps {
    content: ContentLoaderValue;
    children: ReactNode;
    hideContentOnError?: boolean;
    onError?: () => void;
}

export const ContentLoader: React.FC<ContentLoaderProps> = ({ content, children, hideContentOnError, onError }) => {
    const snackbar = useSnackbar();

    useEffect(() => {
        if (content.kind === "error") {
            snackbar.error(`${i18n.t("The data could not be loaded")}: ${content.message}`);
            onError?.();
        }
    }, [content, snackbar, onError]);

    switch (content.kind) {
        case "loading":
            return <CircularProgress />;
        case "error":
            if (hideContentOnError) {
                return null;
            } else {
                return <>{children}</>;
            }
        case "loaded":
            return <>{children}</>;
    }
};
