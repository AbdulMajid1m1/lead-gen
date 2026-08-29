import { useEffect, useMemo, useRef } from "react";
import { ArrowDown, ArrowUpDown, Inbox, SearchX } from "lucide-react";
import { cn } from "../lib/format.js";
import { EmptyState, ErrorState, Skeleton, Spinner } from "./ui.jsx";
import { DataGridPagination } from "./DataGridPagination.jsx";

/**
 * The table the list screens share: a toolbar strip, a sticky-headed scroller
 * and a pagination footer.
 *
 * It is a presentational component with no query state of its own — pair it
 * with `useServerGrid`, which owns the page, sort, search and filters and hands
 * them back through `bind(total)`:
 *
 *   const grid = useServerGrid({ initialSort: "created" });
 *   <DataGrid {...grid.bind(data?.total)} columns={columns} rows={data?.rows} />
 *
 * Column spec
 * -----------
 *   {
 *     key,                                  // identity, and the default accessor
 *     label,
 *     width,                                // CSS width, e.g. "12rem"
 *     align = "left" | "center" | "right",
 *     sortable = false,
 *     sortValue,                            // what onSortChange receives; defaults to `key`
 *     headerClass, cellClass,
 *     render = (row) => row[key] ?? "—",
 *   }
 */

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" };

/**
 * Sorting here is single-key, not an asc/desc/none cycle.
 *
 * The API exposes three fixed orderings — `created`, `score`, `freshness` — and
 * every one of them is descending. A three-state header would offer an
 * ascending order the backend cannot honour, so the click just picks which
 * ordering is in force and the active column shows a filled arrow. Clicking the
 * column that is already active does nothing rather than re-firing the setter,
 * which would bounce the user back to page 1 for no change.
 */
const SortIndicator = ({ active }) =>
  active ? (
    <ArrowDown size={12} className="shrink-0 text-[var(--accent)]" aria-hidden />
  ) : (
    <ArrowUpDown size={12} className="shrink-0 text-[var(--text-subtle)]" aria-hidden />
  );

export const DataGrid = ({
  columns = [],
  rows = [],
  getRowId = (r) => r.id,
  loading = false,
  error = null,
  onRetry,
  empty,
  emptyFiltered,
  hasActiveFilters = false,
  selectable = false,
  selectedIds = [],
  onSelectionChange,
  onRowClick,
  sort = null,
  onSortChange,
  page = 1,
  pageSize = 25,
  total = 0,
  onPageChange,
  onPageSizeChange,
  pagination = true,
  pageSizeOptions = [10, 25, 50, 100],
  minWidth,
  maxHeight = "70vh",
  stickyHeader = true,
  compact = false,
  toolbar,
  className,
}) => {
  const headerCheckbox = useRef(null);
  const colSpan = columns.length + (selectable ? 1 : 0);

  // A refetch with rows already on screen must not blank the table: the user is
  // usually mid-scroll or mid-click, and swapping their rows for skeletons
  // moves the thing they were reaching for. Skeletons are for the first load,
  // when there is nothing to preserve.
  const busy = loading && rows.length > 0;
  const showSkeleton = loading && rows.length === 0;

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const pageIds = useMemo(() => rows.map((row) => getRowId(row)), [rows, getRowId]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPageSelected = !allOnPageSelected && pageIds.some((id) => selected.has(id));

  // `indeterminate` has no HTML attribute — it exists only on the DOM node — so
  // a partly-ticked page needs the ref or the header checkbox reads as "none
  // selected" while rows below it are ticked.
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = someOnPageSelected;
  }, [someOnPageSelected]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // The result set can shrink underneath the user — a filter narrows it, a row
  // is deleted — leaving them on a page past the end staring at an empty table
  // with a healthy count in the footer. Skipped while loading, since `total` is
  // still 0 on a first fetch and would clamp a deep-linked page to 1.
  useEffect(() => {
    if (!pagination || loading || page <= totalPages) return;
    onPageChange?.(totalPages);
  }, [pagination, loading, page, totalPages, onPageChange]);

  const handleSort = (column) => {
    const value = column.sortValue ?? column.key;
    if (value === sort) return;
    onSortChange?.(value);
  };

  const toggleAllOnPage = (checked) => {
    const next = checked
      ? [...new Set([...selectedIds, ...pageIds])]
      : selectedIds.filter((id) => !pageIds.includes(id));
    onSelectionChange?.(next);
  };

  const toggleRow = (id, checked) => {
    onSelectionChange?.(checked ? [...selectedIds, id] : selectedIds.filter((x) => x !== id));
  };

  const cellPad = compact ? "px-3 py-2" : "px-3 py-3";

  const body = () => {
    if (error) {
      return (
        <tr>
          <td colSpan={colSpan}>
            <ErrorState error={error} onRetry={onRetry} />
          </td>
        </tr>
      );
    }

    if (showSkeleton) {
      return Array.from({ length: 5 }).map((_, i) => (
        <tr key={`skeleton-${i}`}>
          <td colSpan={colSpan} className={cn(cellPad, "border-b border-[var(--border)]")}>
            <Skeleton className="h-4 w-full" />
          </td>
        </tr>
      ));
    }

    if (rows.length === 0) {
      return (
        <tr>
          <td colSpan={colSpan}>
            {hasActiveFilters
              ? emptyFiltered ?? (
                  <EmptyState
                    icon={SearchX}
                    title="Nothing matches these filters"
                    description="Loosen a filter or clear the search to see more."
                  />
                )
              : empty ?? <EmptyState icon={Inbox} title="Nothing here yet" />}
          </td>
        </tr>
      );
    }

    return rows.map((row) => {
      const id = getRowId(row);
      const isSelected = selected.has(id);
      return (
        <tr
          key={id}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
          // A clickable row has to be reachable without a mouse. Enter and Space
          // both open it, and Space's default page-scroll is suppressed so the
          // list does not jump away under the row that was just opened.
          tabIndex={onRowClick ? 0 : undefined}
          onKeyDown={
            onRowClick
              ? (e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  onRowClick(row);
                }
              : undefined
          }
          className={cn(
            "transition-colors",
            onRowClick && "cursor-pointer",
            isSelected ? "bg-[var(--accent-soft)]" : onRowClick && "hover:bg-[var(--surface-sunken)]",
          )}
        >
          {selectable && (
            // Ticking a row is not opening it, so the checkbox keeps its click
            // to itself instead of firing onRowClick on the way up.
            <td
              onClick={(e) => e.stopPropagation()}
              className={cn(cellPad, "w-10 border-b border-[var(--border)] align-middle")}
            >
              <input
                type="checkbox"
                checked={isSelected}
                aria-label="Select row"
                onChange={(e) => toggleRow(id, e.target.checked)}
                className="size-4 cursor-pointer accent-[var(--accent)]"
              />
            </td>
          )}
          {columns.map((column) => (
            <td
              key={column.key}
              className={cn(
                cellPad,
                "border-b border-[var(--border)] align-middle text-[13px] text-[var(--text)]",
                ALIGN[column.align] ?? ALIGN.left,
                column.cellClass,
              )}
            >
              {column.render ? column.render(row) : row[column.key] ?? "—"}
            </td>
          ))}
        </tr>
      );
    });
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      {(toolbar || busy) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2 sm:px-4">
          <div className="min-w-0 flex-1">{toolbar}</div>
          {busy && (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <Spinner size={12} />
              Updating
            </span>
          )}
        </div>
      )}

      {/*
        One scroller for both axes. Wide tables scroll inside this box rather
        than widening the page, and the sticky header needs exactly this
        bounded, scrolling ancestor to stick to — a second nested wrapper would
        give it the wrong one and the header would scroll away with the rows.
      */}
      <div
        className="overflow-x-auto overflow-y-auto"
        style={maxHeight ? { maxHeight } : undefined}
        aria-busy={busy || undefined}
      >
        <table
          className="w-full border-separate border-spacing-0 text-sm"
          style={minWidth ? { minWidth } : undefined}
        >
          <thead>
            <tr>
              {selectable && (
                <th
                  scope="col"
                  className={cn(
                    "w-10 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5 text-left",
                    stickyHeader && "sticky top-0 z-10",
                  )}
                >
                  <input
                    ref={headerCheckbox}
                    type="checkbox"
                    checked={allOnPageSelected}
                    // Named for what it does. It ticks the rows on screen, not
                    // the thousands behind the other pages, and saying "all
                    // rows" would be a promise the checkbox cannot keep.
                    aria-label="Select all rows on this page"
                    onChange={(e) => toggleAllOnPage(e.target.checked)}
                    className="size-4 cursor-pointer accent-[var(--accent)]"
                  />
                </th>
              )}
              {columns.map((column) => {
                const sortValue = column.sortValue ?? column.key;
                const isSorted = column.sortable && sortValue === sort;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    // Every ordering the API offers is descending, so an active
                    // column can only ever be announced as such.
                    aria-sort={column.sortable ? (isSorted ? "descending" : "none") : undefined}
                    style={column.width ? { width: column.width, minWidth: column.width } : undefined}
                    className={cn(
                      "border-b border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap text-[var(--text-subtle)]",
                      ALIGN[column.align] ?? ALIGN.left,
                      stickyHeader && "sticky top-0 z-10",
                      column.headerClass,
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => handleSort(column)}
                        className={cn(
                          "inline-flex items-center gap-1.5 uppercase transition-colors hover:text-[var(--text)]",
                          isSorted && "text-[var(--accent)]",
                        )}
                      >
                        {column.label}
                        <SortIndicator active={isSorted} />
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          {/* Dimmed rather than replaced while refetching: enough to say the
              numbers are moving, not enough to hide what they were. */}
          <tbody className={cn("transition-opacity", busy && "opacity-60")}>{body()}</tbody>
        </table>
      </div>

      {/* Mounted through a refetch — the footer is where the cursor already is
          when the next page arrives, and controls that vanish mid-click send
          the user somewhere they did not ask to go. */}
      {pagination && (
        <DataGridPagination
          page={page}
          pageSize={pageSize}
          total={total}
          pageSizeOptions={pageSizeOptions}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}
    </div>
  );
};

export default DataGrid;
