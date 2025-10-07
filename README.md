# Standalone Video API

This folder contains a self-contained API server you can move to your Desktop and run independently. It exposes simple endpoints to fetch video sources and subtitles by TMDB id.

## Endpoints

- GET /api/movie/:tmdbId
  - Returns aggregated playable sources and subtitles for the movie TMDB id.
- GET /api/tv/:tmdbId/season/:season/episode/:episode
  - Returns aggregated playable sources and subtitles for the specific TV episode by TMDB id.

Response format follows the output of `@p-stream/providers` runAll: an object per source/embed with stream URLs and subtitles.

## Environment

Create a `.env` file next to `server.js` with:

- TMDB_API_KEY=your_tmdb_api_key
- PORT=3002 (optional)
- PROXY_URLS=http://your-proxy-1.com,http://your-proxy-2.com (optional)
- M3U8_PROXY_URLS=http://your-m3u8-proxy.com (optional)

## Run

1. Open a terminal in this folder.
2. Install dependencies:

```powershell
pnpm install
```

3. Start the server:

```powershell
pnpm start
```

Server prints the listen URL. Example call:

```powershell
curl "http://localhost:3002/api/movie/603" | Out-Host
```

or TV:

```powershell
curl "http://localhost:3002/api/tv/1399/season/1/episode/1" | Out-Host
```

## Deploy to Vercel

This repo is configured for Vercel serverless deployment using a single Express app behind API routes.

What’s included:

- `vercel.json` routes everything to `api/index.js` (and catch-all `api/[...route].js`) so Express handles both `/` and `/api/*` paths.
- Node.js runtime set to 20.x. No custom build needed.

Required environment variables (set in Vercel Project Settings → Environment Variables):

- `TMDB_API_KEY` (required)
- `PROXY_URLS` (optional)

### One-time via Vercel CLI

```powershell
# Optional: install CLI
npm i -g vercel

# Link and deploy (follow prompts)
vercel

# For production
vercel --prod
```

### Via Vercel Dashboard

1. Create a new project from this repository.
2. Framework preset: “Other”.
3. Set Environment Variables as above.
4. Deploy. Endpoints will be available at:

- GET https://<your-app>.vercel.app/api/movie/:tmdbId
- GET https://<your-app>.vercel.app/api/tv/:tmdbId/season/:season/episode/:episode

You can also call the non-prefixed aliases:

- GET https://<your-app>.vercel.app/movie/:tmdbId
- GET https://<your-app>.vercel.app/tv/:tmdbId/season/:season/episode/:episode
