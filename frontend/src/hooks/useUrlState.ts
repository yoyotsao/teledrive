import { useCallback, useEffect, useState } from 'react';

export type DriveView =
  | { mode: 'folder'; folderId: string | null }
  | { mode: 'search'; query: string }
  | { mode: 'trash' };

export type SortKey = 'name' | 'size' | 'date';
export type SortOrder = 'asc' | 'desc';

export interface UrlState {
  view: DriveView;
  sortBy: SortKey;
  sortOrder: SortOrder;
  navigateFolder: (folderId: string | null) => void;
  openTrash: () => void;
  setSearch: (query: string) => void;
  setSort: (by: SortKey, order: SortOrder) => void;
}

const SORT_KEYS: SortKey[] = ['name', 'size', 'date'];

function parse(search: string): { view: DriveView; sortBy: SortKey; sortOrder: SortOrder } {
  const p = new URLSearchParams(search);
  const sortBy = (SORT_KEYS as string[]).includes(p.get('sort') || '') ? (p.get('sort') as SortKey) : 'date';
  const sortOrder: SortOrder = p.get('order') === 'asc' ? 'asc' : 'desc';

  let view: DriveView;
  if (p.get('view') === 'trash') {
    view = { mode: 'trash' };
  } else if (p.get('q')) {
    view = { mode: 'search', query: p.get('q') as string };
  } else {
    view = { mode: 'folder', folderId: p.get('folder') || null };
  }
  return { view, sortBy, sortOrder };
}

function serialize(view: DriveView, sortBy: SortKey, sortOrder: SortOrder): string {
  const p = new URLSearchParams();
  if (view.mode === 'trash') p.set('view', 'trash');
  else if (view.mode === 'search') p.set('q', view.query);
  else if (view.folderId) p.set('folder', view.folderId);
  if (sortBy !== 'date') p.set('sort', sortBy);
  if (sortOrder !== 'desc') p.set('order', sortOrder);
  const qs = p.toString();
  return qs ? `?${qs}` : window.location.pathname;
}

export function useUrlState(): UrlState {
  const [state, setState] = useState(() => parse(window.location.search));

  useEffect(() => {
    const onPop = () => setState(parse(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const apply = useCallback((next: { view: DriveView; sortBy: SortKey; sortOrder: SortOrder }, push: boolean) => {
    const url = serialize(next.view, next.sortBy, next.sortOrder);
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    setState(next);
  }, []);

  const navigateFolder = useCallback((folderId: string | null) => {
    setState((prev) => {
      const next = { view: { mode: 'folder' as const, folderId }, sortBy: prev.sortBy, sortOrder: prev.sortOrder };
      apply(next, true);
      return next;
    });
  }, [apply]);

  const openTrash = useCallback(() => {
    setState((prev) => {
      const next = { view: { mode: 'trash' as const }, sortBy: prev.sortBy, sortOrder: prev.sortOrder };
      apply(next, true);
      return next;
    });
  }, [apply]);

  const setSearch = useCallback((query: string) => {
    setState((prev) => {
      const q = query.trim();
      // Leaving search (cleared) returns to the drive root; entering search from
      // a non-search view pushes so Back exits search, typing within replaces.
      const next = q
        ? { view: { mode: 'search' as const, query: q }, sortBy: prev.sortBy, sortOrder: prev.sortOrder }
        : { view: { mode: 'folder' as const, folderId: null }, sortBy: prev.sortBy, sortOrder: prev.sortOrder };
      const push = q !== '' && prev.view.mode !== 'search';
      apply(next, push);
      return next;
    });
  }, [apply]);

  const setSort = useCallback((by: SortKey, order: SortOrder) => {
    setState((prev) => {
      const next = { view: prev.view, sortBy: by, sortOrder: order };
      apply(next, false);
      return next;
    });
  }, [apply]);

  return { ...state, navigateFolder, openTrash, setSearch, setSort };
}
