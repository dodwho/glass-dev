import { createTheme } from "@material-ui/core/styles";
import { glassColors } from "../../../../domain/entities/GlassColors";

// Re-exported for existing importers; the colours live in the domain.
export { glassColors };

export const palette = {
    common: {
        white: glassColors.white,
        black: glassColors.black,
    },
    action: {
        active: glassColors.greyBlack,
        disabled: glassColors.greyDisabled,
    },
    text: {
        primary: glassColors.black,
        secondary: glassColors.grey,
        disabled: glassColors.greyDisabled,
        hint: glassColors.grey,
    },
    primary: {
        main: glassColors.mainPrimary,
        dark: glassColors.darkPrimary,
        light: glassColors.lightPrimary,
        lightest: glassColors.accentPrimaryLightest, // Custom extension, not used by default
        // contrastText: 'white',
    },
    secondary: {
        main: glassColors.mainSecondary,
        light: glassColors.lightSecondary,
        dark: glassColors.darkSecondary,
        contrastText: "#fff",
    },
    error: {
        main: glassColors.negative, // This is automatically expanded to main/light/dark/contrastText, what do we use here?
    },
    status: {
        //Custom colors collection, not used by default in MUI
        negative: glassColors.negative,
        warning: glassColors.warning,
        positive: glassColors.positive,
        info: glassColors.info,
    },
    background: {
        paper: glassColors.white,
        default: glassColors.snow,
        grey: "#FCFCFC",
        hover: glassColors.greyLight,
    },
    divider: glassColors.greyLight,
    shadow: glassColors.grey,
};

export const muiTheme = createTheme({
    // colors,
    palette,
    typography: {
        fontFamily: "Roboto, Helvetica, Arial, sans-serif",
        // useNextVariants: true,
    },
    overrides: {
        MuiDivider: {
            light: {
                backgroundColor: palette.divider, // No light dividers for now
            },
        },
    },
});
