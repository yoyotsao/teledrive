/**
 * 上傳工作的身分。兩層：provisional identity 只負責找出候選項目，
 * canonical identity 才決定合併。詳見
 * docs/superpowers/specs/2026-09-06-upload-center-design.md 的「身分判定」。
 */

export interface UploadDestination {
  /** 發起這次上傳時的根目的資料夾（拖放目標或當前資料夾）。建立後不可變。 */
  rootFolderId: string | null;
  /** 根目的資料夾內、不含檔名的相對目錄路徑；單檔／多檔上傳為空字串。不可變。 */
  relativePath: string;
  /** ensureFolder() 是否已回報。null 是合法的解析結果（雲端硬碟根目錄），
   *  所以「尚未解析」需要獨立旗標，不能用 null 表示。 */
  folderResolved: boolean;
  /** 解析後的實際目的資料夾 ID。註冊中繼資料一律使用這個值。 */
  resolvedFolderId: string | null;
}

// 檔名與路徑可能包含任何可見字元，用 Unit Separator 當分隔避免欄位邊界碰撞。
const SEP = '\u001f';
const ROOT = '\u0000root';

function folderKey(id: string | null): string {
  return id === null ? ROOT : id;
}

export function provisionalIdentity(input: {
  destination: UploadDestination;
  name: string;
  size: number;
  lastModified: number;
}): string {
  const { rootFolderId, relativePath } = input.destination;
  return [folderKey(rootFolderId), relativePath, input.name, input.size, input.lastModified].join(SEP);
}

/**
 * resolvedFolderId 與 contentHash 都到齊後才算得出來，在那之前回 null。
 * 不含 relativePath——resolvedFolderId 已經編碼了實際位置，這正是跨入口重試
 * 能夠合併的原因。不含 size——sha256File() 回傳格式本身就是 <hex64>:<size>。
 */
export function canonicalIdentity(input: {
  id: string;
  destination: UploadDestination;
  name: string;
  contentHash: string | null;
  hashSettled: boolean;
}): string | null {
  if (!input.destination.folderResolved || !input.hashSettled) return null;
  // 雜湊算不出來就無法證明內容相同，退回每個項目各自唯一。
  const content = input.contentHash ?? `\u0000nohash${SEP}${input.id}`;
  return [folderKey(input.destination.resolvedFolderId), input.name, content].join(SEP);
}
