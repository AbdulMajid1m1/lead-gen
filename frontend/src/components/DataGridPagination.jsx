import { useMemo } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button, Select } from "./ui.jsx";

/**
 * The <DataGrid> footer: what you are looking at on the left, how to get
 * somewhere else on the right.
 *
 *   Showing 26–50 of 613 · Rows per page       First · Prev · 1 … 5 6 7 … 25 · Next · Last
 */

/**
 * First page, last page, and the current page with a neighbour either side —
 * with an ellipsis wherever that skips something. A 600-page result would
 * otherwise render 600 buttons and push the whole footer off a phone screen.
 */
const buildPageList = (current, totalPages) => {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const wanted = new Set([1, totalPages, current - 1, current, current + 1]);
  const sorted = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out = [];
  sorted.forEach((p, i) => {
    out.push(p);
    if (i < sorted.length - 1 && sorted[i + 1] - p > 1) out.push("…");
  });
  return out;
};

const NavButton = ({ label, disabled, onClick, children }) => (
  <Button
    variant="secondary"
    size="sm"
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className="size-8 shrink-0 p-0"
  >
    {children}
  </Button>
);

export const DataGridPagination = ({
  page,
  pageSize,
  total,
  pageSizeOptions = [10, 25, 50, 100],
  onPageChange,
  onPageSizeChange,
}) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page || 1), totalPages);
  const firstRow = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastRow = Math.min(safePage * pageSize, total);

  const pageList = useMemo(() => buildPageList(safePage, totalPages), [safePage, totalPages]);

  // The active size is always offered, even when it is not one of the standard
  // options — a grid whose size was set elsewhere would otherwise render the
  // select blank and leave the user unable to tell how much they are seeing.
  const sizeOptions = useMemo(
    () => [...new Set([...pageSizeOptions, pageSize].filter((n) => Number(n) > 0))].sort((a, b) => a - b),
    [pageSizeOptions, pageSize],
  );

  // Nothing to page through and nothing to count. A footer reading "Showing 0–0
  // of 0" under an empty state says the same thing twice.
  if (!total) return null;

  return (
    <div className="flex flex-col items-start justify-between gap-3 border-t border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5 sm:flex-row sm:items-center sm:px-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--text-muted)]">
        <span>
          Showing <b className="tnum font-semibold text-[var(--text)]">{firstRow}</b>
          {"–"}
          <b className="tnum font-semibold text-[var(--text)]">{lastRow}</b>
          {" of "}
          <b className="tnum font-semibold text-[var(--text)]">{total}</b>
        </span>
        <label className="flex items-center gap-1.5">
          <span className="whitespace-nowrap">Rows per page</span>
          <Select
            value={pageSize}
            onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
            className="tnum w-auto px-2 py-1 text-xs"
          >
            {sizeOptions.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </Select>
        </label>
      </div>

      <nav aria-label="Pagination" className="flex flex-wrap items-center gap-1">
        <NavButton label="First page" disabled={safePage === 1} onClick={() => onPageChange?.(1)}>
          <ChevronsLeft size={14} />
        </NavButton>
        <NavButton label="Previous page" disabled={safePage === 1} onClick={() => onPageChange?.(safePage - 1)}>
          <ChevronLeft size={14} />
        </NavButton>

        {pageList.map((entry, i) =>
          entry === "…" ? (
            <span
              key={`gap-${i}`}
              aria-hidden
              className="select-none px-1 text-xs text-[var(--text-subtle)]"
            >
              …
            </span>
          ) : (
            <Button
              key={entry}
              type="button"
              variant={entry === safePage ? "primary" : "secondary"}
              size="sm"
              aria-label={`Page ${entry}`}
              aria-current={entry === safePage ? "page" : undefined}
              onClick={() => onPageChange?.(entry)}
              className="tnum size-8 shrink-0 p-0 text-xs"
            >
              {entry}
            </Button>
          ),
        )}

        <NavButton label="Next page" disabled={safePage === totalPages} onClick={() => onPageChange?.(safePage + 1)}>
          <ChevronRight size={14} />
        </NavButton>
        <NavButton label="Last page" disabled={safePage === totalPages} onClick={() => onPageChange?.(totalPages)}>
          <ChevronsRight size={14} />
        </NavButton>
      </nav>
    </div>
  );
};

export default DataGridPagination;
