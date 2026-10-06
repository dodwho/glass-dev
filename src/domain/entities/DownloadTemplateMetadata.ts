import { Id, NamedRef, Ref } from "./Ref";

export type RelationshipConstraint = RelationshipConstraintTei | RelationshipConstraintEventInProgram;

export type RelationshipOrgUnitFilter =
    | "ACCESSIBLE"
    | "CAPTURE"
    | "ALL"
    | "SELECTED"
    | "CHILDREN"
    | "DESCENDANTS"
    | undefined;
export interface RelationshipConstraintTei {
    type: "tei";
    name: string;
    program?: Ref;
    teis: Ref[]; // Selectable TEIs for this constraint
}

export interface RelationshipConstraintEventInProgram {
    type: "eventInProgram";
    program: NamedRef;
    programStage?: NamedRef;
    events: Ref[];
}

export interface RelationshipType {
    id: Id;
    name: string;
    constraints: {
        from: RelationshipConstraint;
        to: RelationshipConstraint;
    };
}
export interface RelationshipMetadata {
    relationshipTypes: RelationshipType[];
}

/** The program or dataset a template is generated for. Only what the domain reads is declared. */
export interface TemplateElement {
    id: Id;
    type: string;
}

export type GetElementMetadataType = {
    element: any;
    metadata: RelationshipMetadata | {};
    elementMetadata: Map<any, any>;
    organisationUnits: {
        id: string;
        displayName: string;
        code?: string | undefined;
        translations: unknown;
        type: string;
    }[];
    rawMetadata: any;
};
