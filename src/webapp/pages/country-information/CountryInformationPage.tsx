import { Button } from "@material-ui/core";
import React from "react";
import styled from "styled-components";
import { StyledBreadCrumbs } from "../../components/breadcrumbs/StyledBreadCrumbs";
import { glassColors } from "../app/themes/dhis2.theme";
import ChevronRightIcon from "@material-ui/icons/ChevronRight";
import { NavLink } from "react-router-dom";
import i18n from "@eyeseetea/d2-ui-components/locales";
import { CountryInformationContent } from "../../components/country-information/CountryInformationContent";
import { useCurrentModuleContext } from "../../contexts/current-module-context";
import { useCurrentOrgUnitContext } from "../../contexts/current-orgUnit-context";
import { useCountryInformation } from "./useCountryInformation";
import { useAppContext } from "../../contexts/app-context";
import { ContentLoader } from "../../components/content-loader/ContentLoader";

export const CountryInformationPage: React.FC = React.memo(() => {
    const { compositionRoot } = useAppContext();

    const { currentOrgUnitAccess } = useCurrentOrgUnitContext();
    const { currentModuleAccess } = useCurrentModuleContext();

    const countryInformationResult = useCountryInformation(
        compositionRoot,
        currentOrgUnitAccess.orgUnitId,
        currentModuleAccess.moduleName
    );

    const click = (event: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
        event.preventDefault();
    };

    return (
        <ContentWrapper>
            <PreContent>
                <StyledBreadCrumbs aria-label="breadcrumb" separator="">
                    <Button component={NavLink} to={`/current-data-submission`} exact={true} onClick={click}>
                        <span>{currentModuleAccess.moduleName}</span>
                    </Button>
                    <ChevronRightIcon />
                    <Button component={NavLink} to={`/country-information`} exact={true}>
                        <span>{i18n.t("Country Information")}</span>
                    </Button>
                </StyledBreadCrumbs>
            </PreContent>

            <ContentLoader content={countryInformationResult} showErrorAsSnackbar={true}>
                {countryInformationResult.kind === "loaded" && (
                    <CountryInformationContent countryInformation={countryInformationResult.data} />
                )}
            </ContentLoader>
        </ContentWrapper>
    );
});

const ContentWrapper = styled.div`
    display: flex;
    flex-direction: column;
    gap: 20px;
`;

const PreContent = styled.div`
    display: flex;
    justify-content: space-between;
    align-items: center;
    .info {
        font-size: 14px;
        span {
            opacity: 0.5;
        }
        span:nth-child(1) {
            color: ${glassColors.green};
            opacity: 1;
        }
    }
`;
