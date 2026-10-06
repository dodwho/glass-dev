declare module "@dhis2/ui" {
    export function HeaderBar(props: { className?: string; appName?: string }): React.ReactElement;
    export function IconChevronDown24(props: { color?: string }): React.ReactElement;
    export function IconCross16(props: { color?: string }): React.ReactElement;
    export const DataTable: React.ComponentType<any>;
    export const TableHead: React.ComponentType<any>;
    export const DataTableRow: React.ComponentType<any>;
    export const DataTableColumnHeader: React.ComponentType<any>;
    export const TableBody: React.ComponentType<any>;
    export const DataTableCell: React.ComponentType<any>;
    export const Radio: React.ComponentType<any>;
    export const Button: React.ComponentType<any>;
    export const Input: React.ComponentType<any>;
    export const TextArea: React.ComponentType<any>;
    export const Checkbox: React.ComponentType<any>;
}
