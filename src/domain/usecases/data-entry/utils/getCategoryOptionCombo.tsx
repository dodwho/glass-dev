import { CategoryCombo } from "../../../entities/metadata/CategoryCombo";
import { ExternalData } from "../../../entities/data-entry/amr-external/ExternalData";
import { DataElement } from "../../../entities/metadata/DataSet";

import {
    AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID,
    DEFAULT_CATEGORY_COMBO_ID,
} from "../../../entities/GlassMetadataReferences";

export { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID };
export const defaultCategoryCombo = DEFAULT_CATEGORY_COMBO_ID;

export function getCategoryOptionComboByDataElement(
    dataElement: DataElement,
    dataElement_CC: CategoryCombo,
    externalData: ExternalData
) {
    //NOTE: for unknown values for gender, origin and ageGroup the files contain the value UNK
    // in the metadata we have a category option separate for every category
    // this funcion map the value in the file to the expected in category option
    return dataElement.categoryCombo.id === defaultCategoryCombo
        ? { categoryOptionComboId: "", error: "" }
        : getCategoryOptionComboByOptionCodes(dataElement_CC, [
              externalData.SPECIMEN.trim(),
              externalData.GENDER.replace("UNK", "UNKG").trim(),
              externalData.ORIGIN.replace("UNK", "UNKO").trim(),
              externalData.AGEGROUP.replace("UNK", "UNKA").trim(),
          ]);
}

type CategoryOptionComboLookup = { categoryOptionComboId: string; error: string };

/**
 * Answers already found, per category combo and codes. A file repeats a few hundred code combinations across all its
 * values, and scanning every option combo for each value took 81 s for an 87,000-value RIS file (27 Oct 2026).
 * Category combos are read-only metadata, so the same codes always get the same answer.
 */
const lookupsByCategoryCombo = new WeakMap<CategoryCombo, Map<string, CategoryOptionComboLookup>>();

export function getCategoryOptionComboByOptionCodes(
    categoryCombo: CategoryCombo,
    codes: string[]
): CategoryOptionComboLookup {
    const lookups = lookupsByCategoryCombo.get(categoryCombo) ?? new Map<string, CategoryOptionComboLookup>();
    lookupsByCategoryCombo.set(categoryCombo, lookups);
    const key = codes.join("\u0000");
    const known = lookups.get(key);
    if (known) return known;

    const categoryOptionCombo = categoryCombo.categoryOptionCombos.find(
        catOpComb =>
            catOpComb.categoryOptions.filter(catOp => codes.includes(catOp.code.trim())).length === codes.length
    );
    const lookup = categoryOptionCombo
        ? { categoryOptionComboId: categoryOptionCombo.id, error: "" }
        : {
              categoryOptionComboId: "",
              error: `Combination of ${categoryCombo.name} not found for codes: "${codes.join(",")}"`,
          };
    lookups.set(key, lookup);
    return lookup;
}
