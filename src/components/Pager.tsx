import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import "./Pager.css";

/** Page numbers to show: first, last, and 3 either side of the current page, with null for a gap ("…"). */
export function pageNumbers(current: number, total: number): (number | null)[] {
  const keep = new Set<number>([1, total]);
  for (let n = current - 3; n <= current + 3; n++) if (n >= 1 && n <= total) keep.add(n);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((n, i) => {
    if (i > 0) {
      const prev = sorted[i - 1];
      if (n - prev === 2) out.push(prev + 1); // a single missing page: show it rather than "…"
      else if (n - prev > 2) out.push(null);
    }
    out.push(n);
  });
  return out;
}

export function paginate<T>(items: T[], page: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  return { pageCount, currentPage, pageItems: items.slice((currentPage - 1) * pageSize, currentPage * pageSize) };
}

/** "N files · First · Prev · 1 … 4 [5] 6 … 20 · Next · Last" — the buttons only show past one page. */
export function Pager({
  total,
  page,
  pageCount,
  onPage,
}: {
  total: number;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="library-pager">
      <span className="muted library-pager-count">
        {total} {total === 1 ? "file" : "files"}
      </span>
      {pageCount > 1 && (
        <>
          <button type="button" title="First page" onClick={() => onPage(1)} disabled={page <= 1}>
            <ChevronsLeft size={14} /> First
          </button>
          <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}>
            <ChevronLeft size={14} /> Prev
          </button>
          <div className="library-pager-pages">
            {pageNumbers(page, pageCount).map((n, i) =>
              n === null ? (
                <span key={`gap-${i}`} className="muted">
                  …
                </span>
              ) : (
                <button
                  key={n}
                  type="button"
                  className={n === page ? "library-page-btn active" : "library-page-btn"}
                  aria-current={n === page ? "page" : undefined}
                  onClick={() => onPage(n)}
                >
                  {n}
                </button>
              )
            )}
          </div>
          <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>
            Next <ChevronRight size={14} />
          </button>
          <button type="button" title="Last page" onClick={() => onPage(pageCount)} disabled={page >= pageCount}>
            Last <ChevronsRight size={14} />
          </button>
        </>
      )}
    </div>
  );
}
