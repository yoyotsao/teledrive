export function resolveAccountLogName(
  accountName: string | null | undefined,
  accountId: number,
): string {
  return accountName?.trim() || String(accountId);
}

export function formatAccountLog(
  accountName: string | null | undefined,
  accountId: number,
  tags: readonly string[],
  message: string,
): string {
  const prefix = [resolveAccountLogName(accountName, accountId), ...tags]
    .map((tag) => `[${tag}]`)
    .join('');
  return `${prefix} ${message}`;
}
