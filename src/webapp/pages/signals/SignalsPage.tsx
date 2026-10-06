import React from "react";
import { Button } from "@material-ui/core";
import { useCurrentModuleContext } from "../../contexts/current-module-context";
import ChevronRightIcon from "@material-ui/icons/ChevronRight";
import { NavLink } from "react-router-dom";
import i18n from "@eyeseetea/d2-ui-components/locales";
import styled from "styled-components";
import { StyledBreadCrumbs } from "../../components/breadcrumbs/StyledBreadCrumbs";
import { glassColors } from "../app/themes/dhis2.theme";
import { SignalTableContent } from "../../components/signals/SignalTableContent";

export const SignalsPage: React.FC = React.memo(() => {
    const { currentModuleAccess } = useCurrentModuleContext();

    return (
        <ContentWrapper>
            <PreContent>
                <StyledBreadCrumbs aria-label="breadcrumb" separator="">
                    <Button component={NavLink} to={`/signals`} exact={true}>
                        <span>{currentModuleAccess.moduleName}</span>
                    </Button>
                    <ChevronRightIcon />
                    <Button component={NavLink} to={`signals`} exact={true}>
                        <span>{i18n.t(`Signals`)}</span>
                    </Button>
                </StyledBreadCrumbs>
            </PreContent>
            <SignalTableContent />
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
