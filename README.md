# Anime API — Jikan (primary) + Official MAL v2 (fallback)

A Next.js API backend that returns anime data in the format your existing PHP HTML pages expect — using **Jikan v4** (unofficial MAL API, no key needed) as the **primary** source, with the **official MyAnimeList API v2** as the **fallback**. No AniList anywhere.

## Data Sources

- **Jikan v4** (`https://api.jikan.moe/v4`) — PRIMARY for everything: search, details, categories (top/seasons/genre filters), episode metadata, streaming links, characters & voice actors, and MAL→AniList ID resolution. Public, no auth, no API key. Rate limit: 3 req/s + 60 req/min per IP.
- **MyAnimeList Official API v2** (`https://api.myanimelist.net/v2`) — FALLBACK for search, details, categories (ranking + seasonal), episodes, schedule. Requires a free `MAL_CLIENT_ID`. Used automatically whenever Jikan fails (it is community-run and periodically 429s/504s).
- **Miruro API** — episodes & streaming servers (Kiwi, Hop providers). Still uses AniList IDs internally; resolved from MAL via Jikan's `/anime/{id}/external` endpoint (AniList link in MAL's external-links sidebar), cached 30 days.

## Quick Start

```bash
# Install dependencies
bun install   # or npm install

# Optional: set your MAL Client ID for the fallback layer
# (free at https://myanimelist.net/apiconfig) — edit .env

# Development
bun run dev   # or npm run dev

# Production
bun run build && bun start
```

> The app works fully on Jikan without any API key. Setting `MAL_CLIENT_ID` only arms the official MAL fallback.

## Environment Variables

Create a `.env` file in the project root:

```env
# === Jikan (primary source, no auth needed) ===
JIKAN_URL=https://api.jikan.moe/v4

# === MyAnimeList Official API v2 (fallback layer) ===
MAL_API_URL=https://api.myanimelist.net/v2
MAL_CLIENT_ID=your-client-id-here   # free at https://myanimelist.net/apiconfig

# === Miruro API (episodes & servers) ===
# NOTE: the default instance may be offline — point this at a working Miruro
# deployment if /api/servers returns DEPLOYMENT_DISABLED errors.
MIRURO_URL=https://miruro-api-theta.vercel.app

# === App ===
ITEMS_PER_PAGE=20
CACHE_TTL_SECONDS=300

# === Redis Cache (optional — falls back to no cache if unavailable) ===
# REDIS_URL=redis://default:password@host:6379/0

# === Webshare Rotating Proxy (optional) ===
# PROXY_HOST=
# PROXY_PORT=80
# PROXY_USER=
# PROXY_PASS=
```

## Project Structure

```
src/
├── lib/
│   ├── config.ts          # Reads .env values
│   ├── jikan.ts           # Jikan v4 client (PRIMARY) + transforms
│   ├── mal.ts             # Official MAL API v2 REST client (FALLBACK) + transforms
│   ├── miruro.ts          # Miruro API client (episodes & servers)
│   ├── proxy.ts           # Webshare proxy agent (optional, defaults to direct fetch)
│   └── redis.ts           # Redis cache with graceful fallback
├── app/
│   ├── page.tsx           # Built-in API test UI
│   └── api/
│       ├── search/route.ts              # Jikan /anime?q= → MAL /anime?q=
│       ├── details/route.ts             # Jikan /anime/{id}/full → MAL /anime/{id}
│       ├── characters/route.ts          # Jikan /anime/{id}/characters (no MAL equivalent)
│       ├── episodes/route.ts            # Jikan /episodes → MAL generated list
│       ├── schedule/route.ts            # Jikan broadcast → MAL broadcast
│       ├── category/[category]/route.ts # Jikan top/seasons/filters → MAL ranking/season
│       ├── servers/route.ts             # Jikan MAL→AniList ID + Miruro
│       └── servers/[id]/route.ts        # Path-based version of servers
public/
package.json
next.config.ts
tsconfig.json
```

## API Endpoints

### Search
```
GET /api/search?keyword=naruto&page=1
```
Search anime by keyword. Jikan `/anime?q=` first, official MAL `/anime?q=` as fallback. Returns 20 results per page.

### Category
```
GET /api/category/{category}?page=1
```

Browse by category. Returns 12 results per page. **Every category is served by Jikan first**:

**Jikan `/top/anime` (MAL `/anime/ranking` fallback):**
- `popular`, `trending`, `airing`, `upcoming`, `tv`, `movie`, `ova`, `special`

**Jikan `/seasons/{year}/{season}` (MAL `/anime/season` fallback):**
- `spring-2025`, `summer-2025`, `fall-2025`, `winter-2025` (any season-year combo)

**Jikan `/top/anime?type=` (no MAL fallback — no matching ranking type):**
- `ona`, `music`

**Jikan `/anime?status=|order_by=` (no MAL fallback — MAL requires `q`):**
- `completed`, `recent`

**Jikan `/anime?genres={malId}` (no MAL fallback — MAL requires `q`):**
- `action`, `adventure`, `comedy`, `drama`, `fantasy`, `horror`, `mystery`, `romance`, `scifi`, `sports`, `supernatural`, `suspense`, `sliceoflife`, `ecchi`, `boyslove`, `girlslove`, `gourmet`, `avantgarde`, `erotica`, `hentai`, `awardwinning`

**Known limitation:** `tvshort`, `cm`, `pv` — neither Jikan nor the official MAL API exposes a filter for these media types (only AniList did). The route attempts a Jikan passthrough filter and returns an empty page with a `note` when unsupported.

The response includes a `backend` field (`"jikan"` or `"mal"`) so you can see which backend served the request.

### Details
```
GET /api/details?malId=16498
GET /api/details?id=attack-on-titan-16498
GET /api/details?id=16498
```

Full anime details. Jikan `/anime/{id}/full` first (single call: synopsis, relations, recommendations, trailer, streaming platforms, related seasons); official MAL `/anime/{id}?fields=...` as fallback.

### Characters
```
GET /api/characters?malId=16498&page=1
```

Paginated character list with Japanese voice actors. Jikan `/anime/{id}/characters` (the official MAL API removed its characters endpoint in 2019, and there is no other free replacement). 25 per page (client-side pagination over the cached full list).

### Episodes
```
GET /api/episodes?malId=16498
```

Episode list with real titles, Japanese titles and filler flags. Jikan `/anime/{id}/episodes` first; official MAL fallback generates a plain "Episode N" list from `num_episodes`.

### Schedule
```
GET /api/schedule?malId=52991
```

Next episode air time. Computed from broadcast day + time (JST → UTC) for currently-airing anime. Jikan first (`broadcast: { day: "Sundays", time: "01:58" }`), official MAL fallback (`broadcast: { day_of_the_week, start_time }`).

### Servers (Streaming)
```
GET /api/servers?malId=16498
GET /api/servers/16498
GET /api/servers/16498?ep=3
GET /api/servers?anilistId=147105   (legacy passthrough)
```

Streaming servers from Miruro. MAL ID is resolved to AniList ID via Jikan `/anime/{id}/external` (the AniList entry in MAL's external-links sidebar, cached for 30 days), then passed to Miruro.

## Slug Format

Every anime `id` field uses the format: `{anime-name}-{malId}`

Examples:
- `naruto-20`
- `attack-on-titan-16498`
- `frieren-beyond-journeys-end-52991`

All detail-dependent endpoints accept:
- Slug: `?id=attack-on-titan-16498`
- MAL ID: `?malId=16498`
- Raw number: `?id=16498`
- AniList ID (legacy): `?anilistId=147105`

## ID Fields in Responses

| Field | Description |
|-------|-------------|
| `id` | Slug format (`attack-on-titan-16498`) — used for URLs |
| `malId` | MyAnimeList numeric ID — primary key |
| `anilistId` | Always `null` now that AniList is removed (kept for response-shape compatibility with your PHP frontend) |

## Architecture Notes

### Why Jikan first, MAL second?

Jikan needs no API key and serves richer data (real episode titles, filler flags, streaming platforms, characters). Its weakness is uptime — it is a free community-run scraper over MAL that periodically 429s/504s. Every route therefore wraps its Jikan call in a try/catch and retries the same request against the official MAL API v2, so a Jikan outage degrades data richness instead of breaking the app.

### What replaced AniList?

| AniList was used for | Replaced by |
|---|---|
| Characters & voice actors (`Media(idMal:)`) | Jikan `/anime/{id}/characters` (includes VAs per character) |
| MAL → AniList ID resolution | Jikan `/anime/{id}/external` → parse `anilist.co/anime/{id}` from MAL's external links |
| Category fallback (genres/status/media types) | Jikan `/anime?genres=&status=&type=&order_by=` — filters work without `q` |
| Category fallback (tvshort/cm/pv) | Removed (no source) — empty page + explanatory note |
| Proxy-status health check | Removed from `/api/proxy-status` (now checks Jikan + MAL only) |

### IPv4-only + HTTP/1.1 ALPN

The HTTP client uses `node:https.request` directly (not `fetch`) with IPv4 preference and `ALPNProtocols: ['http/1.1']`. This is necessary in sandboxed environments without IPv6 routing, and because MAL/Jikan TLS endpoints don't support HTTP/2 — Node's default `fetch` (undici) hangs during ALPN negotiation before giving up.

### Rate limiting

- Jikan: throttled to ~2.5 req/s (polite default), retry with exponential backoff on 429/5xx
- MAL API v2: throttled to ~3 req/s, retry with exponential backoff on 429/5xx
- Miruro: per-host, no throttling

## Caching

- Redis cache (optional, falls back to no cache if unavailable)
- All responses include `Cache-Control` headers for CDN caching
- MAL→AniList ID mappings cached for 30 days (rarely change)
- Jikan /full and /characters cached for 24 hours
- Search results cached for 24 hours
- Details cached for 48 hours (12h when served from the MAL fallback)
- Episodes cached for 12 hours
- Schedule cached for 12 hours
- Category cached for 24 hours

## Technologies

- Next.js 15 (App Router, API Routes)
- TypeScript
- Jikan v4 (primary source)
- MyAnimeList Official API v2 (fallback)
- Miruro API
- ioredis (Redis cache)
- https-proxy-agent (optional Webshare proxy)
