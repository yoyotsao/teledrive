from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# GramJS: carry the frozen peer and persisted random ID to every message-creating send.
replace_once(
    'frontend/src/lib/gramjs.ts',
    '''  private async sendFileWithOptionalThumb(\n    params: Record<string, unknown>,\n    thumb?: Blob | null,\n  ): Promise<{ message: unknown; hasThumbnail: boolean }> {\n    if (!thumb) {\n      return { message: await this.sendFileLocked(params), hasThumbnail: false };\n    }''',
    '''  private async sendFileWithOptionalThumb(\n    params: Record<string, unknown>,\n    thumb?: Blob | null,\n    targetPeer: any = "me",\n  ): Promise<{ message: unknown; hasThumbnail: boolean }> {\n    if (!thumb) {\n      return { message: await this.sendFileLocked(params, 3, targetPeer), hasThumbnail: false };\n    }''',
)
replace_once(
    'frontend/src/lib/gramjs.ts',
    '''    const message = await this.sendFileLocked({ ...params, thumb: thumbFile });''',
    '''    const message = await this.sendFileLocked({ ...params, thumb: thumbFile }, 3, targetPeer);''',
)
replace_once(
    'frontend/src/lib/gramjs.ts',
    '''  async uploadSmallFile(file: File, thumb?: Blob | null): Promise<SegmentResult & { hasThumbnail: boolean }> {''',
    '''  async uploadSmallFile(\n    file: File,\n    thumb?: Blob | null,\n    targetPeer: any = "me",\n    randomId?: string,\n  ): Promise<SegmentResult & { hasThumbnail: boolean }> {''',
)
replace_once(
    'frontend/src/lib/gramjs.ts',
    '''      const { message, hasThumbnail } = await this.sendFileWithOptionalThumb({\n        file: customFile,\n        workers: 4,\n        forceDocument: true,\n      }, thumb);''',
    '''      const { message, hasThumbnail } = await this.sendFileWithOptionalThumb({\n        file: customFile,\n        workers: 4,\n        forceDocument: true,\n        ...(randomId ? { randomId } : {}),\n      }, thumb, targetPeer);''',
)
replace_once(
    'frontend/src/lib/gramjs.ts',
    '''  asSegmentRunner(): SegmentAttemptRunner {\n    return {\n      accountId: this.accountId,\n      accountName: resolveAccountLogName(this.accountName, this.accountId),\n      run: (input) => this.uploadSegmentAttempt(input),\n    };\n  }\n\n  private async uploadSegmentAttempt(input: SegmentAttemptInput): Promise<SegmentResult & { hasThumbnail: boolean }> {''',
    '''  asSegmentRunner(sendTarget?: { targetPeer?: any; randomIds?: readonly string[] }): SegmentAttemptRunner {\n    return {\n      accountId: this.accountId,\n      accountName: resolveAccountLogName(this.accountName, this.accountId),\n      run: (input) => this.uploadSegmentAttempt(input, sendTarget),\n    };\n  }\n\n  private async uploadSegmentAttempt(\n    input: SegmentAttemptInput,\n    sendTarget?: { targetPeer?: any; randomIds?: readonly string[] },\n  ): Promise<SegmentResult & { hasThumbnail: boolean }> {''',
)
replace_once(
    'frontend/src/lib/gramjs.ts',
    '''    const { message, hasThumbnail } = await this.sendFileWithOptionalThumb({\n      file: new Api.InputFileBig({ id: fileId, parts: segment.parts, name: file.name }),\n      forceDocument: true,\n    }, segment.index === 0 ? thumb : undefined);''',
    '''    const randomId = sendTarget?.randomIds?.[segment.index];\n    const { message, hasThumbnail } = await this.sendFileWithOptionalThumb({\n      file: new Api.InputFileBig({ id: fileId, parts: segment.parts, name: file.name }),\n      forceDocument: true,\n      ...(randomId ? { randomId } : {}),\n    }, segment.index === 0 ? thumb : undefined, sendTarget?.targetPeer ?? "me");''',
)

# Split uploader: pinned shared-channel work must remain on the selected live writer.
replace_once(
    'frontend/src/lib/splitUpload.ts',
    '''export type SplitUploadProgress = (percent: number, detail?: SplitUploadProgressDetail) => void;''',
    '''export type SplitUploadProgress = (percent: number, detail?: SplitUploadProgressDetail) => void;\n\nexport interface FrozenSplitSendTarget {\n  targetPeer: any;\n  randomIds: readonly string[];\n}''',
)
replace_once(
    'frontend/src/lib/splitUpload.ts',
    '''    thumb?: Blob | null,\n    pinned?: TelegramClientManager,\n  ): Promise<SplitUploadResult> {''',
    '''    thumb?: Blob | null,\n    pinned?: TelegramClientManager,\n    sendTarget?: FrozenSplitSendTarget,\n  ): Promise<SplitUploadResult> {''',
)
replace_once(
    'frontend/src/lib/splitUpload.ts',
    '''      const result = await run((client) => client.uploadSmallFile(file, thumb));''',
    '''      const result = await run((client) => client.uploadSmallFile(\n        file, thumb, sendTarget?.targetPeer ?? "me", sendTarget?.randomIds?.[0],\n      ));''',
)
replace_once(
    'frontend/src/lib/splitUpload.ts',
    '''    const runners = (pinned ? [pinned] : deps.clients()).map((client) => client.asSegmentRunner());''',
    '''    const runners = (pinned ? [pinned] : deps.clients()).map((client) =>\n      client.asSegmentRunner(pinned ? sendTarget : undefined),\n    );''',
)
replace_once(
    'frontend/src/lib/splitUpload.ts',
    '''  thumb?: Blob | null,\n  pinned?: TelegramClientManager,\n): Promise<SplitUploadResult> {\n  return productionUploadFileSpread(file, onProgress, thumb, pinned);''',
    '''  thumb?: Blob | null,\n  pinned?: TelegramClientManager,\n  sendTarget?: FrozenSplitSendTarget,\n): Promise<SplitUploadResult> {\n  return productionUploadFileSpread(file, onProgress, thumb, pinned, sendTarget);''',
)
