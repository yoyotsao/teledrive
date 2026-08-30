/**
 * An in-memory stand-in for the TeleDrive backend, good enough to drive the
 * whole file browser without a server, a database or Telegram.
 *
 * It is a replica of the rules the real backend enforces — the same ones
 * backend/tests/test_api_files_listing.py and test_api_trash.py pin — because
 * a fake that answers more loosely than the server would let UI tests pass on
 * behaviour the app will never actually see:
 *
 *   * /files at a folder returns FILES only; folders come from /folders
 *   * search spans the whole drive and DOES include folders
 *   * the trash lists only trashed roots, never their contents
 *   * a split file appears once, as its part 0
 *   * deleting is a soft delete of the whole subtree
 *
 * `requests` records every call, so a test can assert what the UI asked for
 * (e.g. that changing the sort re-queries the server rather than re-sorting a
 * stale page).
 */

export type Row = {
  file_id: string;
  filename: string;
  filesize: number;
  mime_type: string | null;
  file_type: string;
  telegram_message_id: number | null;
  has_thumbnail: boolean;
  created_at: string;
  direct_url: string | null;
  access_hash: string | null;
  parent_id: string | null;
  isDir: boolean;
  is_split_file: boolean;
  split_group_id: string | null;
  part_index: number | null;
  total_parts: number | null;
  file_hash: string | null;
  telegram_user_id: number;
  trashed_at: string | null;
};

export type SeedRow = Partial<Row> & { file_id: string };

let clock = 0;

function makeRow(seed: SeedRow): Row {
  clock += 1;
  return {
    filename: seed.file_id,
    filesize: 0,
    mime_type: null,
    file_type: 'other',
    telegram_message_id: null,
    has_thumbnail: false,
    // Distinct ascending stamps so date sorting is deterministic.
    created_at: `2026-01-01T00:00:${String(clock).padStart(2, '0')}`,
    direct_url: null,
    access_hash: null,
    parent_id: null,
    isDir: false,
    is_split_file: false,
    split_group_id: null,
    part_index: null,
    total_parts: null,
    file_hash: null,
    telegram_user_id: 42,
    trashed_at: null,
    ...seed,
  };
}

const SORT_KEYS: Record<string, (row: Row) => string | number> = {
  name: (r) => r.filename.toLowerCase(),
  size: (r) => r.filesize,
  date: (r) => r.created_at,
};

export class FakeDrive {
  rows: Row[] = [];
  requests: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];

  seed(...seeds: SeedRow[]): this {
    for (const seed of seeds) this.rows.push(makeRow(seed));
    return this;
  }

  folder(file_id: string, extra: SeedRow | Record<string, never> = {} as never): this {
    return this.seed({ ...(extra as SeedRow), file_id, isDir: true });
  }

  file(file_id: string, extra: Partial<Row> = {}): this {
    return this.seed({ file_id, ...extra });
  }

  get(fileId: string): Row | undefined {
    return this.rows.find((r) => r.file_id === fileId);
  }

  names(): string[] {
    return this.rows.filter((r) => !r.trashed_at).map((r) => r.filename);
  }

  /** The row plus every descendant — what a delete or restore acts on. */
  private subtree(rootId: string): Row[] {
    const out: Row[] = [];
    const walk = (id: string) => {
      const row = this.get(id);
      if (!row) return;
      out.push(row);
      for (const child of this.rows.filter((r) => r.parent_id === id)) walk(child.file_id);
    };
    walk(rootId);
    return out;
  }

  private sorted(rows: Row[], sortBy: string, sortOrder: string, foldersFirst: boolean): Row[] {
    const key = SORT_KEYS[sortBy] ?? SORT_KEYS.date;
    const direction = sortOrder === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const av = key(a);
      const bv = key(b);
      if (av < bv) return -1 * direction;
      if (av > bv) return 1 * direction;
      return a.file_id < b.file_id ? -1 : 1; // stable tiebreak, as the server does
    });
  }

  /** GET /files */
  listFiles(query: URLSearchParams) {
    const page = Number(query.get('page') ?? 1);
    const pageSize = Number(query.get('page_size') ?? 50);
    const search = (query.get('search') ?? '').trim();
    const trashed = query.get('trashed') === 'true';
    const splitGroupId = query.get('split_group_id');
    const rawParent = query.get('parent_id');
    const parentId = rawParent === 'null' || rawParent === null ? null : rawParent;
    const sortBy = query.get('sort_by') ?? 'date';
    const sortOrder = query.get('sort_order') ?? 'desc';

    // Search and trash span the drive and return folders too.
    const spanning = Boolean(search) || trashed;
    const primaryPartOnly = (r: Row) => !r.is_split_file || r.part_index === 0 || r.part_index === null;

    let rows: Row[];
    if (trashed) {
      const trashedIds = new Set(this.rows.filter((r) => r.trashed_at).map((r) => r.file_id));
      rows = this.rows.filter(
        (r) => r.trashed_at && (r.parent_id === null || !trashedIds.has(r.parent_id)),
      );
    } else if (search) {
      const needle = search.toLowerCase();
      rows = this.rows.filter((r) => !r.trashed_at && r.filename.toLowerCase().includes(needle));
    } else if (splitGroupId) {
      rows = this.rows.filter((r) => !r.trashed_at && r.split_group_id === splitGroupId);
    } else {
      rows = this.rows.filter(
        (r) => !r.trashed_at && !r.isDir && r.parent_id === parentId,
      );
    }
    if (!splitGroupId) rows = rows.filter(primaryPartOnly);

    const ordered = splitGroupId
      ? [...rows].sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0))
      : this.sorted(rows, sortBy, sortOrder, spanning);
    const start = (page - 1) * pageSize;

    return {
      files: ordered.slice(start, start + pageSize),
      total: ordered.length,
      page,
      page_size: pageSize,
    };
  }

  /** GET /folders */
  listFolders(query: URLSearchParams) {
    const rawParent = query.get('parent_id');
    const parentId = rawParent === 'null' || rawParent === null ? null : rawParent;
    const rows = this.rows.filter((r) => !r.trashed_at && r.isDir && r.parent_id === parentId);
    const ordered = this.sorted(
      rows, query.get('sort_by') ?? 'date', query.get('sort_order') ?? 'desc', false,
    );
    return { files: ordered, total: ordered.length, page: 1, page_size: ordered.length };
  }

  /** POST /folders — idempotent on (name, parent), like the server. */
  createFolder(name: string, parentId: string | null): Row {
    const existing = this.rows.find(
      (r) => r.isDir && !r.trashed_at && r.filename === name && r.parent_id === parentId,
    );
    if (existing) return existing;
    const row = makeRow({ file_id: `folder-${this.rows.length + 1}`, filename: name, parent_id: parentId, isDir: true });
    this.rows.push(row);
    return row;
  }

  /** PATCH /files/{id} */
  patch(fileId: string, body: { filename?: string; parent_id?: string | null }): Row | null {
    const row = this.get(fileId);
    if (!row) return null;
    if ('filename' in body && body.filename !== undefined) row.filename = body.filename;
    if ('parent_id' in body) row.parent_id = body.parent_id ?? null;
    return row;
  }

  /** DELETE /files/{id} and DELETE /folders/{id} — soft, whole subtree. */
  trash(fileId: string): number {
    const rows = this.subtree(fileId);
    const stamp = new Date().toISOString();
    for (const row of rows) row.trashed_at = stamp;
    return rows.length;
  }

  restore(fileId: string): Row | null {
    const row = this.get(fileId);
    if (!row) return null;
    for (const descendant of this.subtree(fileId)) descendant.trashed_at = null;
    // Restoring under a parent that is gone or still trashed goes to the root.
    const parent = row.parent_id ? this.get(row.parent_id) : null;
    if (row.parent_id && (!parent || parent.trashed_at)) row.parent_id = null;
    return row;
  }

  purge(fileId: string): number {
    const ids = new Set(this.subtree(fileId).map((r) => r.file_id));
    this.rows = this.rows.filter((r) => !ids.has(r.file_id));
    return ids.size;
  }
}
