/**
 * A quoted CSV text cell that is safe to open in a spreadsheet. A cell starting with = + - @ (or a tab or
 * carriage return) would be run as a formula by Excel, and error messages can contain values copied from the
 * uploaded file, so such a cell gets a leading apostrophe. Embedded quotes are doubled.
 */
export function csvTextCell(value: unknown): string {
    const text = value === null || value === undefined ? "" : String(value);
    const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
}
