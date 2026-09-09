import type { ReactNode } from "react";

export function ChartDataTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: string[];
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{row.map((value, j) => <td key={j}>{value}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
