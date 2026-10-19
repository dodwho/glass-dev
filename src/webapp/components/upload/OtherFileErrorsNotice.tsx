import React from "react";
import { Button, Typography } from "@material-ui/core";
import styled from "styled-components";
import i18n from "@eyeseetea/d2-ui-components/locales";
import { ImportSummary } from "../../../domain/entities/data-entry/ImportSummary";
import { moduleProperties } from "../../../domain/utils/ModuleProperties";
import { glassColors } from "../../pages/app/themes/dhis2.theme";

export type FileTab = "primary" | "secondary";

interface OtherFileErrorsNoticeProps {
    moduleName: string;
    openTab: FileTab;
    primaryFileImportSummary?: ImportSummary;
    secondaryFileImportSummary?: ImportSummary;
    onShow: (tab: FileTab) => void;
}

/**
 * The upload steps show one file at a time (RIS or SAMPLE tab). When the file that is not open has blocking errors,
 * the user must see it at once, not only after clicking the other tab.
 */
export const OtherFileErrorsNotice: React.FC<OtherFileErrorsNoticeProps> = ({
    moduleName,
    openTab,
    primaryFileImportSummary,
    secondaryFileImportSummary,
    onShow,
}) => {
    const otherTab: FileTab = openTab === "primary" ? "secondary" : "primary";
    const otherSummary = otherTab === "primary" ? primaryFileImportSummary : secondaryFileImportSummary;
    if (!otherSummary || otherSummary.blockingErrors.length === 0) return null;

    const properties = moduleProperties.get(moduleName);
    const fileType = otherTab === "primary" ? properties?.primaryFileType : properties?.secondaryFileType;

    return (
        <Notice role="alert">
            <Typography>
                {i18n.t("The {{fileType}} file has errors that must be corrected before you can continue.", {
                    fileType,
                })}
            </Typography>
            <Button variant="outlined" color="primary" onClick={() => onShow(otherTab)}>
                {i18n.t("Show the {{fileType}} file errors", { fileType })}
            </Button>
        </Notice>
    );
};

const Notice = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 20px;
    border-left: 4px solid ${glassColors.red};
    box-shadow: rgb(0 0 0 / 12%) 0px 1px 6px, rgb(0 0 0 / 12%) 0px 1px 4px;
`;
