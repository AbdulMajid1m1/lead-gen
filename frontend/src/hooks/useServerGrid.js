import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Query state for a server-driven <DataGrid> — page, page size, sort, free-text
 * search and a flat map of filters — plus the request params they serialise to.
 *
 * The grid never filters, sorts or slices anything in the browser: it renders
 * the page the API handed back. This hook owns the query state, the caller owns
 * the fetch, and the backend owns FILTER → SORT → PAGINATE and the `total` that
 * comes with it.
 *
 *   const grid = useServerGrid({ initialSort: "created", scope: tab });
 *   const { data } = useQuery({
 *     queryKey: ["promoted-products", ...grid.queryKey],
 *     queryFn: () => api.listPromotedProducts(grid.params),
 *     placeholderData: keepPreviousData,
 *   });
 *   <DataGrid {...grid.bind(data?.total)} columns={columns} rows={data?.products} />
 *
 * Page resets
 * -----------
 * Anything that can shrink the result set — a filter, the search box, the sort,
 * the page size, or an external `scope` such as a status tab — sends the user
 * back to page 1, because page 7 of a result set they have not seen the start
 * of is not a place anyone asked to be. Each reset happens inside the setter so
 * the change and the reset land in one render and only one request goes out;
 * setting them separately at the call site fires two.
 */

const DEFAULT_PAGE_SIZE = 25;

/**
 * A debounced copy of `value`. Inlined here rather than imported so a grid
 * costs one hook file instead of two — nothing else in the app debounces yet,
 * and a one-consumer module is a file to keep in sync for no benefit.
 */
const useDebouncedValue = (value, delay) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
};

/**
 * Drops blank values, so `filters` only ever holds filters that actually narrow
 * the query. Without this an untouched dropdown ships `status=""` to the API and
 * `hasActiveFilters` claims the user filtered something when they did not — the
 * empty state would then blame their filters for a genuinely empty result.
 */
const prune = (source) => {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    const text = value == null ? "" : String(value);
    if (text !== "") out[key] = text;
  }
  return out;
};

export const useServerGrid = ({
  initialSort = null,
  initialPageSize = DEFAULT_PAGE_SIZE,
  initialFilters = {},
  // Any narrowing the caller applies outside the grid — a pipeline tab, a date
  // range, a selected product. A change here means a different result set.
  scope = null,
  searchDebounceMs = 300,
} = {}) => {
  const [page, setPageRaw] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(initialPageSize);
  const [sort, setSortRaw] = useState(initialSort);
  const [filters, setFiltersRaw] = useState(() => prune(initialFilters));
  const [search, setSearchRaw] = useState("");

  const debouncedSearch = useDebouncedValue(search, searchDebounceMs);
  const trimmedSearch = debouncedSearch.trim();

  const setPage = useCallback((next) => {
    const n = Number(next);
    if (!Number.isFinite(n) || n < 1) return;
    setPageRaw(Math.floor(n));
  }, []);

  const setPageSize = useCallback((next) => {
    const n = Number(next);
    if (!Number.isFinite(n) || n < 1) return;
    setPageSizeRaw(Math.floor(n));
    setPageRaw(1);
  }, []);

  const setSort = useCallback((next) => {
    setSortRaw(next ?? null);
    setPageRaw(1);
  }, []);

  const setSearch = useCallback((next) => {
    setSearchRaw(next ?? "");
    setPageRaw(1);
  }, []);

  const setFilter = useCallback((key, value) => {
    setFiltersRaw((prev) => prune({ ...prev, [key]: value }));
    setPageRaw(1);
  }, []);

  /** Patches several filters at once; clearing one is passing it as "". */
  const setFilters = useCallback((patch) => {
    setFiltersRaw((prev) => prune({ ...prev, ...patch }));
    setPageRaw(1);
  }, []);

  const clearFilters = useCallback(() => {
    setFiltersRaw({});
    setSearchRaw("");
    setPageRaw(1);
  }, []);

  const reset = useCallback(() => {
    setFiltersRaw({});
    setSearchRaw("");
    setSortRaw(initialSort);
    setPageRaw(1);
  }, [initialSort]);

  // `scope` is usually an object literal rebuilt on every render, so compare it
  // by value: keying the effect on the object itself would reset the page on
  // every keystroke the parent re-rendered for.
  const scopeKey = useMemo(() => JSON.stringify(scope ?? null), [scope]);
  const previousScope = useRef(scopeKey);
  useEffect(() => {
    if (previousScope.current === scopeKey) return;
    previousScope.current = scopeKey;
    setPageRaw(1);
  }, [scopeKey]);

  const activeFilterCount = Object.keys(filters).length;
  const hasActiveFilters = activeFilterCount > 0 || trimmedSearch !== "";

  /**
   * Request params. Empty parts are omitted rather than sent blank, so the API
   * sees the absence of a filter instead of having to treat "" as "any".
   * Filters go in first: a filter named `page` must not be able to hijack the
   * pagination the grid is driving.
   */
  const params = useMemo(() => {
    const next = { ...filters, page, pageSize };
    if (sort) next.sort = sort;
    if (trimmedSearch) next.search = trimmedSearch;
    return next;
  }, [filters, page, pageSize, sort, trimmedSearch]);

  /**
   * Cache key covering every input to the request, which is what makes a slow
   * response for an abandoned query harmless — it lands under its own key
   * instead of overwriting the newer one.
   */
  const queryKey = useMemo(
    () => [page, pageSize, sort ?? null, trimmedSearch, filters, scopeKey],
    [page, pageSize, sort, trimmedSearch, filters, scopeKey],
  );

  /** Props to spread into <DataGrid>. `total` comes from the API response. */
  const bind = useCallback(
    (total = 0) => ({
      page,
      pageSize,
      total: Number(total) || 0,
      sort,
      onPageChange: setPage,
      onPageSizeChange: setPageSize,
      onSortChange: setSort,
    }),
    [page, pageSize, sort, setPage, setPageSize, setSort],
  );

  return {
    page,
    pageSize,
    sort,
    search,
    debouncedSearch: trimmedSearch,
    filters,
    hasActiveFilters,
    activeFilterCount,
    params,
    queryKey,
    setPage,
    setPageSize,
    setSort,
    setSearch,
    setFilter,
    setFilters,
    clearFilters,
    reset,
    bind,
  };
};

export default useServerGrid;
