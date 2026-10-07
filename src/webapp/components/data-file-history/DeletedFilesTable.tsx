import React from "react";
import { Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@material-ui/core";
import dayjs from "dayjs";
import i18n from "@eyeseetea/d2-ui-components/locales";
import { GlassUploads } from "../../../domain/entities/GlassUploads";
import { moduleProperties } from "../../../domain/utils/ModuleProperties";
import { useCurrentModuleContext } from "../../contexts/current-module-context";
import { TableContentWrapper } from "./DataFileTable";

const NOT_RECORDED = "Not recorded";
const DATE_TIME_FORMAT = "YYYY-MM-DD HH:mm:ss";

export interface DeletedFilesTableProps {
    items: GlassUploads[];
}

export const DeletedFilesTable: React.FC<DeletedFilesTableProps> = ({ items }) => {
    const { currentModuleAccess } = useCurrentModuleContext();
    const isBatchReq = moduleProperties.get(currentModuleAccess.moduleName)?.isbatchReq;

    return (
        <TableContentWrapper>
            <Typography variant="h3">{i18n.t("Deleted files")}</Typography>

            <TableContainer component={Paper}>
                <Table>
                    <TableHead>
                        <TableRow>
                            <TableCell>{i18n.t("Filename")}</TableCell>
                            <TableCell>{i18n.t("File Type")}</TableCell>
                            <TableCell>{i18n.t("Period")}</TableCell>
                            {isBatchReq && <TableCell>{i18n.t("Batch Id")}</TableCell>}
                            <TableCell>
                                {currentModuleAccess.moduleName === "AMC"
                                    ? i18n.t("Products/Substances")
                                    : i18n.t("Rows")}
                            </TableCell>
                            <TableCell>{i18n.t("Uploaded by")}</TableCell>
                            <TableCell>{i18n.t("Uploaded at")}</TableCell>
                            <TableCell>{i18n.t("Deletion requested by")}</TableCell>
                            <TableCell>{i18n.t("Deletion requested at")}</TableCell>
                            <TableCell>{i18n.t("Deletion reason")}</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {items.length === 0 ? (
                            <TableRow>
                                <TableCell>{i18n.t("No deleted files found")}</TableCell>
                            </TableRow>
                        ) : (
                            items.map(upload => (
                                <TableRow key={upload.id}>
                                    <TableCell>{upload.fileName}</TableCell>
                                    <TableCell>{upload.fileType}</TableCell>
                                    <TableCell>{upload.period}</TableCell>
                                    {isBatchReq && <TableCell>{upload.batchId}</TableCell>}
                                    <TableCell>{upload.rows}</TableCell>
                                    <TableCell>{upload.uploadedBy ?? i18n.t(NOT_RECORDED)}</TableCell>
                                    <TableCell>
                                        {upload.uploadDate ? dayjs(upload.uploadDate).format(DATE_TIME_FORMAT) : ""}
                                    </TableCell>
                                    <TableCell>{upload.deletionRequest?.requestedBy ?? i18n.t(NOT_RECORDED)}</TableCell>
                                    <TableCell>
                                        {upload.deletionRequest?.requestedAt
                                            ? dayjs(upload.deletionRequest.requestedAt).format(DATE_TIME_FORMAT)
                                            : i18n.t(NOT_RECORDED)}
                                    </TableCell>
                                    <TableCell>{upload.deletionRequest?.reason || i18n.t(NOT_RECORDED)}</TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </TableContainer>
        </TableContentWrapper>
    );
};
