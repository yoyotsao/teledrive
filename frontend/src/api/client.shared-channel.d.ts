import './client.ts';

declare module './client.ts' {
  interface TelegramOperation {
    destination_photo_variant?: string | null;
  }
}
