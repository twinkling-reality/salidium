/** The header is row 1; virtualized data rows start at row 2 in the accessibility tree. */
export function historyAriaRowCount(dataRows: number): number {
  return dataRows + 1;
}

export function historyAriaRowIndex(dataIndex: number): number {
  return dataIndex + 2;
}
