import https from 'node:https';
import { URL } from 'node:url';
import { JIKAN_URL, CACHE_TTL_SECONDS } from './config';
import { redisGet, redisSet } from './redis';
import { slugify } from './mal';
import { getProxyAgent, getDirectAgent, isProxyConnectError, resolveThrottleMs, PROXY_FALLBACK_DIRECT } from './proxy';

// ============================================================
// JIKAN v4 — unofficial MAL scraper API. Public, no auth.
// Docs: https://docs.api.jikan.moe/
//
// PRIMARY data source. Used for:
//   - Anime details      → GET /anime/{id}/full
//   - Search             → GET /anime?q=...
//   - Category browsing  → GET /top/anime, /seasons/{year}/{season}, /anime?genres=...
//   - Episode metadata   → GET /anime/{id}/episodes (titles, filler flags)
//   - Streaming links    → GET /anime/{id}/streaming
//   - Characters + VAs   → GET /anime/{id}/characters (MAL API v2 removed this)
//   - MAL → AniList ID   → GET /anime/{id}/external (AniList link in MAL's
//     external-links sidebar; needed by Miruro, which only takes AniList IDs)
//
// The official MAL API v2 (mal.ts) is the FALLBACK for everything above:
// whenever Jikan fails (it is community-run and regularly 429s / 504s),
// routes retry against MAL directly.
//
// Rate limit: 3 req/s + 60 req/min per IP (community-run, no uptime
// guarantee). All requests go through the Webshare ROTATING proxy (fresh
// exit IP per request) when configured, so the per-IP caps stop applying
// to the server's own address. Pacing stays polite by default (Jikan is
// free/community-run) and is overridable via JIKAN_THROTTLE_MS.
// ============================================================

function buildKey(prefix: string, ...parts: string[]): string {
  return parts.length ? `${prefix}:${parts.join(':')}` : prefix;
}

export async function getCached(prefix: string, ...parts: string[]): Promise<unknown | null> {
  return redisGet(buildKey(prefix, ...parts));
}

export async function setCache(prefix: string, parts: string[], data: unknown, ttl = CACHE_TTL_SECONDS): Promise<void> {
  await redisSet(buildKey(prefix, ...parts), data, ttl);
}

// --- REST fetch (same rationale as mal.ts: native https, http/1.1) ---
//
// Pacing: Jikan's 3 req/s + 60/min caps are per-IP, and with per-request
// exit-IP rotation they stop binding — but Jikan is a free community
// service, so the default stays polite at 400ms (~2.5 req/s) either way.
// JIKAN_THROTTLE_MS overrides it if you want to push harder.
const JIKAN_RESOLVED_INTERVAL_MS = resolveThrottleMs('JIKAN_THROTTLE_MS', 400, 400);
export { JIKAN_RESOLVED_INTERVAL_MS };

let lastReqAt = 0;

async function throttle() {
  const now = Date.now();
  const wait = JIKAN_RESOLVED_INTERVAL_MS - (now - lastReqAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

/**
 * One HTTPS GET attempt through the given agent.
 * `agent` comes from proxy.ts: the rotating proxy agent (keepAlive: false,
 * fresh exit IP per call) or the shared direct agent.
 */
function httpsGetOnce(url: URL, timeoutMs: number, agent: https.Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: { Accept: 'application/json', 'User-Agent': 'cine-mal-api/1.0' },
      ALPNProtocols: ['http/1.1'],
      agent,
      timeout: timeoutMs,
    } as https.RequestOptions;
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => reject(err));
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

/**
 * Routed GET: through the rotating proxy first; on a proxy-side failure
 * (unreachable proxy, rejected credentials/407, dropped tunnel) retry ONCE
 * direct instead of failing the whole request. Origin API statuses are
 * returned as-is — the retry loop in jikanFetch owns those.
 *
 * NOTE on 407: https-proxy-agent deliberately REPLAYS the proxy's 407
 * response as the request's HTTP response (so credentials never reach a
 * misbehaving proxy — see hackerone 541502). That means "proxy rejected
 * our credentials" shows up as res.status === 407, not as a thrown error,
 * and must be handled as a proxy-side failure here.
 */
async function rawHttpsGet(url: URL, timeoutMs: number): Promise<{ status: number; body: string }> {
  const proxyAgent = getProxyAgent();
  if (!proxyAgent) return httpsGetOnce(url, timeoutMs, getDirectAgent());

  let proxied: { status: number; body: string };
  try {
    proxied = await httpsGetOnce(url, timeoutMs, proxyAgent);
  } catch (err) {
    if (!PROXY_FALLBACK_DIRECT || !isProxyConnectError(err)) throw err;
    console.warn(
      `[jikan] proxy tunnel failed (${(err as Error).message}) — falling back to direct for ${url.pathname}`
    );
    return httpsGetOnce(url, timeoutMs, getDirectAgent());
  }

  if (proxied.status === 407) {
    console.warn('[jikan] proxy rejected credentials (HTTP 407) — check PROXY_USER/PROXY_PASS in .env');
    if (!PROXY_FALLBACK_DIRECT) return proxied;
    return httpsGetOnce(url, timeoutMs, getDirectAgent());
  }

  return proxied;
}

/**
 * Fetch a Jikan v4 endpoint.
 *
 * @param path - Path under /v4, e.g. "/anime/16498" or "/anime/16498/episodes"
 * @param params - Query string parameters (skipped if undefined/null/empty)
 * @param timeoutMs - Per-attempt timeout in milliseconds
 */
export async function jikanFetch<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  timeoutMs = 15000
): Promise<T> {
  const url = new URL(`${JIKAN_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const MAX_RETRIES = 1;
  // 429 = rate limited (Jikan's most common failure mode by far).
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    try {
      const res = await rawHttpsGet(url, timeoutMs);

      if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(
          `[jikan] ${url.pathname}${url.search} returned ${res.status} on attempt ${attempt}/${MAX_RETRIES} — retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        lastReqAt = 0; // reset throttle so we don't double-wait
        continue;
      }

      if (res.status === 404) {
        const err = new Error(`Jikan 404 — ${url.pathname}${url.search}`) as NodeJS.ErrnoException;
        err.code = 'EJIKANSTATUS';
        throw err;
      }
      if (res.status >= 400) {
        // Tag with a code so the catch block below does NOT retry it —
        // retrying a 400 (bad MAL ID format etc.) is pointless.
        const err = new Error(`Jikan API HTTP ${res.status} — ${res.body.slice(0, 300)}`) as NodeJS.ErrnoException;
        err.code = 'EJIKANSTATUS';
        throw err;
      }

      try {
        return JSON.parse(res.body) as T;
      } catch {
        const err = new Error(`Jikan API returned non-JSON response (status ${res.status}): ${res.body.slice(0, 200)}`) as NodeJS.ErrnoException;
        err.code = 'EJSONPARSE';
        throw err;
      }
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      const retryable = !code || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code);
      if (attempt < MAX_RETRIES && retryable) {
        const backoffMs = 500 * Math.pow(2, attempt - 1);
        console.warn(
          `[jikan] ${url.pathname}${url.search} network error on attempt ${attempt}/${MAX_RETRIES}: ${code || (err as Error).message} — retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        lastReqAt = 0;
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('jikanFetch: max retries exceeded');
}

// ============================================================
// TYPES — only the fields we actually use
// ============================================================

export interface JikanStreamingLink {
  name: string; // e.g. "Crunchyroll"
  url: string;
}

export interface JikanEpisode {
  mal_id: number;
  url: string;
  title: string;
  title_japanese?: string;
  title_romanji?: string;
  aired?: string;
  filler: boolean;
  recap: boolean;
  forum_url?: string;
}

interface JikanPagination {
  last_visible_page: number;
  has_next_page: boolean;
  current_page: number;
  items: { count: number; total: number; per_page: number };
}

// ============================================================
// CALLS
// ============================================================

/**
 * GET /anime/{id}/streaming — legal streaming platform links reported by MAL.
 * Cached for 24h since these change infrequently.
 */
export async function getStreamingLinks(malId: number): Promise<JikanStreamingLink[]> {
  const cached = await getCached('jikan-streaming', String(malId));
  if (cached) return cached as JikanStreamingLink[];

  const res = await jikanFetch<{ data: JikanStreamingLink[] }>(`/anime/${malId}/streaming`);
  const links = res.data || [];
  await setCache('jikan-streaming', [String(malId)], links, 86400);
  return links;
}

/**
 * GET /anime/{id}/episodes — paginated. Returns ALL pages concatenated
 * (Jikan caps at 100 episodes/page). Cached for 24h.
 */
export async function getEpisodes(malId: number): Promise<JikanEpisode[]> {
  const cached = await getCached('jikan-episodes', String(malId));
  if (cached) return cached as JikanEpisode[];

  const all: JikanEpisode[] = [];
  let page = 1;
  while (true) {
    const res = await jikanFetch<{ data: JikanEpisode[]; pagination: JikanPagination }>(
      `/anime/${malId}/episodes`,
      { page }
    );
    all.push(...(res.data || []));
    if (!res.pagination?.has_next_page) break;
    page += 1;
  }

  await setCache('jikan-episodes', [String(malId)], all, 86400);
  return all;
}

/**
 * GET /anime/{id}/episodes/{episode} — single episode detail (synopsis included,
 * which the list endpoint above doesn't return).
 */
export async function getEpisodeDetail(malId: number, episodeNo: number): Promise<JikanEpisode & { synopsis?: string }> {
  const res = await jikanFetch<{ data: JikanEpisode & { synopsis?: string } }>(
    `/anime/${malId}/episodes/${episodeNo}`
  );
  return res.data;
}

// ============================================================
// MAL FALLBACK — used by /api/details when malFetch() itself fails
// (MAL down, rate-limited, client ID rejected, etc). Jikan is a scraper
// over the same MAL data, so /anime/{id}/full covers almost everything
// transformDetail() needs, in a single call.
// ============================================================

interface JikanFullAnime {
  mal_id: number;
  url: string;
  images?: { jpg?: { large_image_url?: string; image_url?: string } };
  title: string;
  title_english?: string;
  title_japanese?: string;
  title_synonyms?: string[];
  type?: string;
  episodes?: number;
  status?: string;
  airing?: boolean;
  aired?: { from?: string; to?: string; string?: string };
  duration?: string;
  rating?: string;
  score?: number;
  members?: number;
  synopsis?: string;
  background?: string;
  season?: string;
  year?: number;
  studios?: Array<{ name: string }>;
  producers?: Array<{ name: string }>;
  genres?: Array<{ name: string }>;
  explicit_genres?: Array<{ name: string }>;
  demographics?: Array<{ name: string }>;
  themes?: Array<{ name: string }>;
  broadcast?: {
    day?: string;        // "Sundays" (plural, capitalized)
    time?: string;       // "01:58" JST
    timezone?: string;   // "Asia/Tokyo"
    string?: string;     // "Sundays at 01:58 (JST)"
  };
  trailer?: { youtube_id?: string; url?: string; images?: { medium_image_url?: string } };
  relations?: Array<{
    relation: string;
    entry: Array<{ mal_id: number; type: string; name: string }>;
  }>;
  streaming?: Array<{ name: string; url: string }>;
}

/**
 * GET /anime/{id}/full — cached 24h, same TTL family as the other Jikan calls.
 * Throws on failure (429 exhausted, 404, network) — caller decides what to do.
 */
export async function getAnimeFull(malId: number): Promise<JikanFullAnime> {
  const cached = await getCached('jikan-full', String(malId));
  if (cached) return cached as JikanFullAnime;

  const res = await jikanFetch<{ data: JikanFullAnime }>(`/anime/${malId}/full`);
  if (!res.data) throw new Error(`Jikan /anime/${malId}/full returned no data`);

  await setCache('jikan-full', [String(malId)], res.data, 86400);
  return res.data;
}

const SEASON_MAP: Record<string, string> = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' };
const RELATION_KEEP = new Set([
  'Sequel', 'Prequel', 'Parent story', 'Side story',
  'Alternative version', 'Alternative setting', 'Spin-off', 'Full story', 'Summary',
]);

function deriveRatingFromGenres(genres: string[]): string {
  if (genres.includes('Hentai')) return 'Rx';
  if (genres.includes('Erotica')) return 'R+';
  if (genres.includes('Ecchi')) return 'R+';
  if (genres.includes('Horror')) return 'R';
  return 'PG-13';
}

/**
 * Transforms a Jikan /full response into EXACTLY the same shape as
 * transformDetail() in mal.ts, so /api/details callers see an identical
 * object regardless of which source served the request.
 */
export function transformJikanDetail(a: JikanFullAnime) {
  const malId = a.mal_id;
  const displayTitle = a.title_english || a.title || a.title_japanese || 'Unknown Title';
  const genres = [...(a.genres || []), ...(a.explicit_genres || [])].map((g) => g.name);
  const episodes = a.episodes || 0;
  const studios = (a.studios || []).map((s) => s.name);
  const producers = (a.producers || []).map((p) => p.name);

  const premiered = a.season && a.year
    ? `${SEASON_MAP[a.season.toLowerCase()] || a.season} ${a.year}`
    : '';

  const seasonRelations = (a.relations || [])
    .filter((r) => RELATION_KEEP.has(r.relation))
    .flatMap((r) => r.entry)
    .filter((e) => e.type === 'anime')
    .map((e) => ({
      id: slugify(e.name, e.mal_id),
      malId: e.mal_id,
      anilistId: null,
      title: e.name,
      name: e.name,
      poster: '', // Jikan relations don't include images without a further call
    }));

  const currentEntry = {
    id: slugify(displayTitle, malId),
    malId,
    anilistId: null,
    title: displayTitle,
    name: a.title || '',
    poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
  };

  const trailers = a.trailer?.youtube_id
    ? [{ title: displayTitle, thumbnail: a.trailer.images?.medium_image_url || '', source: a.trailer.url || '' }]
    : [];

  return {
    id: slugify(displayTitle, malId),
    malId,
    anilistId: null,
    title: displayTitle,
    jname: a.title || a.title_japanese || '',
    japanese: a.title_japanese || a.title || '',
    synonyms: (a.title_synonyms && a.title_synonyms.length) ? a.title_synonyms.join(', ') : (a.title || ''),
    overview: a.synopsis || '',
    poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
    banner: '',
    rating: a.rating || deriveRatingFromGenres(genres),
    quality: 'HD',
    subEp: episodes,
    dubEp: 0,
    showType: a.type || 'TV',
    duration: a.duration || '',
    aired: a.aired?.string || '',
    premiered,
    status: a.status || 'Unknown',
    malscore: a.score ? a.score.toFixed(2) : '',
    genres,
    studio: studios.join(', '),
    producer: producers,
    season: [currentEntry, ...seasonRelations],
    actors: [],
    trailers,
    recommendedAnimes: [], // Jikan's /full doesn't include this — separate /recommendations call, skipped to keep fallback fast
    adultContent: genres.includes('Hentai'),
    siteUrl: a.url || `https://myanimelist.net/anime/${malId}`,
    averageScore: a.score ? Math.round(a.score * 10) : null,
    popularity: a.members || 0,
    nextAiringEpisode: null,
    streamingLinks: a.streaming || [],
    _source: 'jikan-fallback', // flag so you can tell in logs/analytics when MAL was down
  };
}

/**
 * One-call convenience: fetch + transform in the shape /api/details expects.
 */
export async function getDetailFallback(malId: number) {
  const full = await getAnimeFull(malId);
  return transformJikanDetail(full);
}

// ============================================================
// ANIME BASIC — GET /anime/{id} (lightweight, no relations).
// Cached 24h. Used when a route only needs title/status/broadcast/
// episodes count without the weight of /full.
// ============================================================

interface JikanBasicAnime extends JikanFullAnime {}

export async function getAnimeBasic(malId: number): Promise<JikanBasicAnime> {
  const cached = await getCached('jikan-basic', String(malId));
  if (cached) return cached as JikanBasicAnime;

  const res = await jikanFetch<{ data: JikanBasicAnime }>(`/anime/${malId}`);
  if (!res.data) throw new Error(`Jikan /anime/${malId} returned no data`);

  await setCache('jikan-basic', [String(malId)], res.data, 86400);
  return res.data;
}

// ============================================================
// CHARACTERS + VOICE ACTORS — replaces the AniList GraphQL characters
// query. GET /anime/{id}/characters returns the FULL character list
// (no pagination param), so we fetch once, cache 24h, and paginate
// client-side to match the previous AniList page shape (25/page).
// ============================================================

export interface JikanCharacterEntry {
  character: { mal_id: number; name: string; images?: { jpg?: { image_url?: string }; webp?: { image_url?: string } } };
  role: string; // "Main" | "Supporting"
  voice_actors: Array<{
    person: { mal_id: number; name: string; images?: { jpg?: { image_url?: string } } };
    language: string; // "Japanese", "English", ...
  }>;
}

export interface JikanCharacterPage {
  edges: JikanCharacterEntry[];
  pageInfo: { total: number; currentPage: number; lastPage: number; hasNextPage: boolean; perPage: number };
}

export async function getCharacters(malId: number, page = 1, perPage = 25): Promise<JikanCharacterPage> {
  const all = await (async () => {
    const cached = await getCached('jikan-characters', String(malId));
    if (cached) return cached as JikanCharacterEntry[];

    const res = await jikanFetch<{ data: JikanCharacterEntry[] }>(`/anime/${malId}/characters`);
    const entries = res.data || [];
    await setCache('jikan-characters', [String(malId)], entries, 86400);
    return entries;
  })();

  const total = all.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;

  return {
    edges: all.slice(start, start + perPage),
    pageInfo: {
      total,
      currentPage: page,
      lastPage,
      hasNextPage: page < lastPage,
      perPage,
    },
  };
}

// ============================================================
// MAL → ANILIST ID RESOLUTION — replaces the AniList GraphQL
// `Media(idMal:)` lookup. Miruro only accepts AniList IDs, so we parse
// the AniList link out of MAL's external-links sidebar via Jikan:
//   GET /anime/{id}/external → [{ name: "AniList", url: "https://anilist.co/anime/21459" }]
// Result cached for 30 days (same as the old AniList lookup), including
// misses, because MAL↔AniList mappings rarely change.
// ============================================================

export async function resolveAnilistId(malId: number): Promise<number | null> {
  const cacheKey = `al:mal:${malId}`;
  const cached = (await redisGet(buildKey(cacheKey))) as string | null;
  if (cached === 'null') return null;
  if (cached) return parseInt(cached, 10);

  try {
    const res = await jikanFetch<{ data: Array<{ name: string; url: string }> }>(
      `/anime/${malId}/external`
    );
    const link = (res.data || []).find(
      (l) => l.name?.toLowerCase() === 'anilist' || (l.url || '').includes('anilist.co/anime')
    );
    const match = link?.url?.match(/anilist\.co\/anime\/(\d+)/);
    const anilistId = match ? parseInt(match[1], 10) : null;

    // Cache both hits and misses
    await redisSet(buildKey(cacheKey), anilistId ? String(anilistId) : 'null', 30 * 86400);
    return anilistId;
  } catch (err) {
    console.warn(`[jikan] failed to resolve AniList ID for MAL ${malId}:`, err);
    return null;
  }
}

// ============================================================
// LIST / BROWSE ENDPOINTS — replaces AniList `Page.media` browsing.
// Jikan's search-style /anime endpoint filters WITHOUT a `q` parameter,
// which is exactly why the old code needed AniList for genres/status.
// ============================================================

interface JikanListAnime {
  mal_id: number;
  url?: string;
  images?: { jpg?: { large_image_url?: string; image_url?: string } };
  title: string;
  title_english?: string;
  title_japanese?: string;
  type?: string;
  episodes?: number;
  status?: string;
  aired?: { from?: string; to?: string };
  duration?: string;
  rating?: string;
  score?: number;
  members?: number;
  popularity?: number;
  synopsis?: string;
  season?: string;
  year?: number;
  studios?: Array<{ name: string }>;
  genres?: Array<{ name: string }>;
  explicit_genres?: Array<{ name: string }>;
}

interface JikanPaginationInfo {
  last_visible_page: number;
  has_next_page: boolean;
  current_page: number;
  items?: { count: number; total: number; per_page: number };
}

function cleanDesc(html: string | null, max = 200): string {
  if (!html) return '';
  const t = html.replace(/<[^>]*>/g, '').replace(/\n/g, ' ').trim();
  return t.length > max ? t.substring(0, max) + '...' : t;
}

function jikanDuration(duration?: string): string {
  // Jikan: "24 min per ep" / "1 hr 50 min" → keep "24 min" style
  if (!duration) return '';
  const m = duration.match(/^(\d+)\s*min/);
  return m ? `${m[1]} min` : '';
}

function jikanRating(rating?: string): string {
  // Jikan: "PG-13 - Teens 13 or older" → "PG-13"
  if (!rating) return 'PG-13';
  return rating.split(' - ')[0] || 'PG-13';
}

/**
 * Transform a Jikan list item (from /anime, /top/anime, /seasons/...)
 * into EXACTLY the shape mal.ts transformMedia() produces, so category
 * responses look identical no matter which source served the request.
 */
export function transformJikanMedia(a: JikanListAnime) {
  const displayTitle = a.title_english || a.title || a.title_japanese || 'Unknown Title';
  const malId = a.mal_id;
  const episodes = a.episodes || 0;
  const genres = (a.genres || []).map((g) => g.name);
  const explicit = (a.explicit_genres || []).map((g) => g.name);
  const allGenres = [...genres, ...explicit];
  const durationMin = jikanDuration(a.duration);
  const studios = (a.studios || []).map((s) => s.name);

  return {
    id: slugify(displayTitle, malId),
    malId,
    anilistId: null as number | null,
    title: displayTitle,
    japanese_title: a.title_japanese || a.title || '',
    poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
    banner: '',
    description: cleanDesc(a.synopsis || null),
    adultContent: explicit.includes('Hentai') || explicit.includes('Erotica') || (a.rating || '').startsWith('Rx'),
    tvInfo: {
      showType: a.type || 'TV',
      rating: jikanRating(a.rating),
      sub: episodes,
      dub: 0,
      duration: durationMin,
    },
    duration: durationMin,
    episodes,
    format: a.type || 'TV',
    genres: allGenres,
    averageScore: a.score ? Math.round(a.score * 10) : null, // MAL 0–10 → 0–100 scale
    popularity: a.members || a.popularity || 0,
    status: a.status || '',
    season: a.season ? a.season.charAt(0).toUpperCase() + a.season.slice(1) : '',
    seasonYear: a.year ?? null,
    siteUrl: a.url || `https://myanimelist.net/anime/${malId}`,
    studios,
    nextAiringEpisode: null as null,
  };
}

export interface JikanBrowseResult {
  data: ReturnType<typeof transformJikanMedia>[];
  hasNextPage: boolean;
  total: number | null;
}

/** Shared mapper for paginated Jikan list responses. */
function mapListResponse(
  res: { data?: JikanListAnime[]; pagination?: JikanPaginationInfo }
): JikanBrowseResult {
  const items = res.data || [];
  return {
    data: items.map(transformJikanMedia),
    hasNextPage: !!res.pagination?.has_next_page,
    total: res.pagination?.items?.total ?? null,
  };
}

/**
 * GET /top/anime — ranking-based categories.
 * ranking_type: all | airing | upcoming | bypopularity | favorite
 * type (optional): tv | movie | ova | special | ona | music
 */
export async function getTopAnime(opts: {
  rankingType?: string;
  type?: string;
  page?: number;
  limit?: number;
}): Promise<JikanBrowseResult> {
  const res = await jikanFetch<{ data: JikanListAnime[]; pagination: JikanPaginationInfo }>(
    '/top/anime',
    {
      ranking_type: opts.rankingType,
      type: opts.type,
      page: opts.page || 1,
      limit: opts.limit || 25,
      sfw: 'true',
    }
  );
  return mapListResponse(res);
}

/**
 * GET /anime?q=... — keyword search.
 */
export async function searchAnime(opts: { q: string; page?: number; limit?: number }): Promise<JikanBrowseResult> {
  const res = await jikanFetch<{ data: JikanListAnime[]; pagination: JikanPaginationInfo }>(
    '/anime',
    {
      q: opts.q,
      page: opts.page || 1,
      limit: opts.limit || 25,
      sfw: 'true',
    }
  );
  return mapListResponse(res);
}

/**
 * GET /seasons/{year}/{season} — seasonal browsing.
 */
export async function getSeasonAnime(opts: {
  year: number;
  season: string;
  page?: number;
  limit?: number;
}): Promise<JikanBrowseResult> {
  const res = await jikanFetch<{ data: JikanListAnime[]; pagination: JikanPaginationInfo }>(
    `/seasons/${opts.year}/${opts.season}`,
    {
      page: opts.page || 1,
      limit: opts.limit || 25,
      sfw: 'true',
    }
  );
  return mapListResponse(res);
}

/**
 * GET /anime?... — filtered browsing WITHOUT a search query. This is the
 * direct replacement for the old AniList `Page.media` fallback:
 *   - genres (comma-separated MAL genre IDs)
 *   - status: airing | complete | upcoming
 *   - type: tv | movie | ova | special | ona | music
 *   - order_by: start_date | members | popularity | score | ...
 *   - sort: asc | desc
 *
 * NOTE: Jikan does not expose filters for MAL's `tv_short`, `cm` or `pv`
 * media types (no official MAL filter for them either) — those niche
 * categories return an empty result with a note from the category route.
 */
export async function getFilteredAnime(opts: {
  genres?: string;
  status?: 'airing' | 'complete' | 'upcoming';
  type?: string;
  orderBy?: string;
  sort?: 'asc' | 'desc';
  minScore?: number;
  page?: number;
  limit?: number;
}): Promise<JikanBrowseResult> {
  const res = await jikanFetch<{ data: JikanListAnime[]; pagination: JikanPaginationInfo }>(
    '/anime',
    {
      genres: opts.genres,
      status: opts.status,
      type: opts.type,
      order_by: opts.orderBy,
      sort: opts.sort,
      min_score: opts.minScore,
      page: opts.page || 1,
      limit: opts.limit || 25,
      sfw: 'true',
    }
  );
  return mapListResponse(res);
}
