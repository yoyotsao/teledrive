# Frontend Agent Guide

## OVERVIEW

React + TypeScript SPA using Vite. Files upload/download directly via MTProto (GramJS in browser) with backend storing only metadata.

## STRUCTURE

```
frontend/
├── src/
│   ├── api/client.ts       # Axios API client for backend
│   ├── components/
│   │   ├── ChonkyDrive.tsx # File browser with drag-drop upload
│   │   └── SessionConfig.tsx
│   ├── types/index.ts      # TypeScript interfaces
│   ├── App.tsx             # Root component
│   └── main.tsx            # Entry point
├── index.html
├── vite.config.ts          # Dev server with API proxy
└── tsconfig.json           # Strict TypeScript
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| File browser | `src/components/ChonkyDrive.tsx` | Drag-drop upload, folder navigation, thumbnails |
| API client | `src/api/client.ts` | All backend calls (axios), thumbnail generation |
| Types | `src/types/index.ts` | FileInfo, FileListResponse interfaces |
| Config | `vite.config.ts` | Dev proxy to backend, env vars |

## CONVENTIONS

- **Strict TypeScript**: `strict: true`, `noUnusedLocals`, `noUnusedParameters`
- **Inline styles**: All styling done inline (no CSS modules or Tailwind)
- **Axios for API**: All backend communication via `src/api/client.ts`

## ANTI-PATTERNS

- **Don't upload through backend** — use GramJS MTProto for direct browser → Telegram
- **Files never pass through backend** — only metadata (file_id, access_hash, message_id)