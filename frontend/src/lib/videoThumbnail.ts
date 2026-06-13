/**
 * Generate a thumbnail from a video file using browser's video element and canvas.
 * This is much faster than using FFmpeg WASM - captures first frame instantly.
 * @param videoFile - The video file to extract thumbnail from
 * @param seekTime - Time in seconds to seek to (default: 0 for first frame)
 * @returns Promise<Blob> - JPEG image blob
 */
export async function generateVideoThumbnail(videoFile: File, seekTime: number = 0): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Failed to get canvas context'));
      return;
    }

    // Set video attributes for thumbnail extraction
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = false;

    // Create object URL for the video file
    const videoUrl = URL.createObjectURL(videoFile);

    video.onloadedmetadata = () => {
      // Scale down to max 320px wide to keep JPEG well under 256KB
      const MAX_WIDTH = 320;
      const ratio = Math.min(1, MAX_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * ratio);
      canvas.height = Math.round(video.videoHeight * ratio);

      video.currentTime = Math.min(seekTime || 0.1, video.duration);
    };

    video.onseeked = () => {
      try {
        // Draw video frame to canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Convert canvas to blob
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(videoUrl);
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Failed to create blob from canvas'));
            }
          },
          'image/jpeg',
          0.85 // JPEG quality
        );
      } catch (err) {
        URL.revokeObjectURL(videoUrl);
        reject(err);
      }
    };

    video.onerror = () => {
      URL.revokeObjectURL(videoUrl);
      reject(new Error('Failed to load video file'));
    };

    // Load the video
    video.src = videoUrl;
  });
}
