import {
    GetElementMetadataType,
    RelationshipOrgUnitFilter,
    TemplateElement,
} from "../entities/DownloadTemplateMetadata";
import { DataFormType } from "../entities/DataForm";
import { Id, NamedRef } from "../entities/Ref";
import { TrackedEntityInstance } from "../entities/TrackedEntityInstance";
import { DataPackage } from "../entities/data-entry/DataPackage";
import { Moment } from "moment";

export interface GetDataPackageParams {
    type: DataFormType;
    id: Id;
    orgUnits: Id[];
    periods?: Id[];
    startDate?: Moment;
    endDate?: Moment;
    translateCodes?: boolean;
    relationshipsOuFilter?: RelationshipOrgUnitFilter;
    filterTEIEnrollmentDate?: boolean;
    /** Max concurrent per-org-unit fetches (events / tracked entities). Defaults to 1 (sequential)
     *  when omitted — existing callers are unaffected unless they opt in. */
    fetchConcurrency?: number;
    /** Optional id -> human-readable label (e.g. country code) used only for progress logging
     *  during the per-org-unit fetch loops. Falls back to the raw org unit id when omitted or when
     *  a given id has no entry. */
    orgUnitLabels?: Record<Id, string>;
    /** trackerPrograms only: skip the tracked-entity fetch entirely and return dataEntries alone
     *  (trackedEntityInstances: []). For a caller that already holds a complete tracked-entity set
     *  fetched separately (see getTrackedEntities) and wants events only, avoiding a redundant,
     *  enrollment-date-scoped re-fetch of the same tracked entities on every call. */
    skipTrackedEntityInstances?: boolean;
}

export interface GetTrackedEntitiesParams {
    programId: Id;
    orgUnits: Id[];
    /** Max concurrent per-org-unit fetches. Defaults to 1 (sequential) when omitted. */
    fetchConcurrency?: number;
    /** Optional id -> human-readable label (e.g. country code), used only for progress logging. */
    orgUnitLabels?: Record<Id, string>;
}

export interface GetElementMetadataParams {
    element: any;
    orgUnitIds: string[];
    downloadRelationships: boolean;
    startDate?: Date;
    endDate?: Date;
    populateStartDate?: Date;
    populateEndDate?: Date;
}

export interface DownloadTemplateRepository {
    getBuilderMetadata(teis: TrackedEntityInstance[]): Promise<BuilderMetadata>;
    getDataPackage(params: GetDataPackageParams): Promise<DataPackage>;
    getElement(type: string, id: string): Promise<TemplateElement>;
    getElementMetadata(params: GetElementMetadataParams): Promise<GetElementMetadataType>;
    /** Fetches every tracked entity for a program/org-unit set, unfiltered by enrollment date — the
     *  complete register, independent of any date window a caller might otherwise apply to events. */
    getTrackedEntities(params: GetTrackedEntitiesParams): Promise<TrackedEntityInstance[]>;
}

export interface BuilderMetadata {
    orgUnits: Record<Id, NamedRef>;
    options: Record<Id, NamedRef & { code: string }>;
    categoryOptionCombos: Record<Id, NamedRef>;
}

export const emptyBuilderMetadata: BuilderMetadata = {
    orgUnits: {},
    options: {},
    categoryOptionCombos: {},
};
