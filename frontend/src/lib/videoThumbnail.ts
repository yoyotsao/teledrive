import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;

/**
 * Load FFmpeg WASM module. Call this once before using generateVideoThumbnail.
 * Uses CDN to load the ffmpeg-core WASM files.
 */
export async function loadFFmpeg(): Promise<void> {
  if (ffmpeg?.loaded) {
    return;
  }

  ffmpeg = new FFmpeg();

  const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });
}

/**
 * Generate a thumbnail from a video file by extracting a frame at 1 second.
 * @param videoFile - The video file to extract thumbnail from
 * @returns Promise<Blob> - JPEG image blob
 */
export async function generateVideoThumbnail(videoFile: File): Promise<Blob> {
  if (!ffmpeg || !ffmpeg.loaded) {
    await loadFFmpeg();
  }

  if (!ffmpeg) {
    throw new Error("FFmpeg failed to initialize");
  }

  const inputFileName = "input_video";
  const outputFileName = "thumbnail.jpg";

  // Write video file to FFmpeg virtual filesystem
  await ffmpeg.writeFile(inputFileName, await fetchFile(videoFile));

  // Extract frame at 1 second into JPEG
  await ffmpeg.exec([
    "-i",
    inputFileName,
    "-ss",
    "00:00:01",
    "-vframes",
    "1",
    "-q:v",
    "2",
    outputFileName,
  ]);

  // Read the generated thumbnail
  const data = await ffmpeg.readFile(outputFileName);

  // Clean up virtual files
  await ffmpeg.deleteFile(inputFileName);
  await ffmpeg.deleteFile(outputFileName);

  // Handle both Uint8Array and string return types
  let blobData: ArrayBuffer;
  if (typeof data === "string") {
    blobData = new TextEncoder().encode(data).buffer as ArrayBuffer;
  } else {
    // Create a new ArrayBuffer with the exact size to avoid SharedArrayBuffer issues
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    blobData = buffer;
  }

  // Return as Blob
  return new Blob([blobData], { type: "image/jpeg" });
}
