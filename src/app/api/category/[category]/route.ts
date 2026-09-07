import { NextRequest, NextResponse } from 'next/server';
import { malFetch, transformMedia, MAL_LIST_FIELDS, MAL_GENRE_IDS, type MalRankingType, getCached, setCache } from '@/lib/mal';
import { getTopAnime, getSeasonAnime, getFilteredAnime, type JikanBrowseResult } from '@/lib/jikan';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PER_PAGE = 12;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

// ============================================================
// Category config — JIKAN FIRST, official MAL as fallback
// ============================================================
//
// Every category is served by Jikan first (it filters without a `q`
// parameter, unlike MAL's /anime endpoint, and needs no API key):
//
// GROUP A — ranking categories → Jikan /top/anime?ranking_type=|type=
//   popular, trending, upcoming, airing, tv, movie, ova, special
//   MAL fallback: /anime/ranking?ranking_type=...
//
// GROUP A — seasons → Jikan /seasons/{year}/{season}
//   spring-2025, fall-2026, etc.
//   MAL fallback: /anime/season/{year}/{season}
//
// GROUP B — Jikan-only (official MAL cannot express these filters —
// its /anime endpoint refuses to filter without a `q` term):
//   - completed (status=complete), recent (order_by=start_date)
//   - all genres (action, comedy, drama, ...) → /anime?genres={MAL id}
//   - ona, music → /top/anime?type=...  (Jikan-only: no MAL ranking type)
//   - tvshort, cm, pv → /anime?type=...  (no MAL/Jikan filter exists;
//     these return an empty page with a note)
// ============================================================

// Ranking categories that ALSO have an official MAL fallback
const RANKING_CATEGORIES: Record<string, MalRankingType> = {
  popular: 'bypopularity',
  trending: 'favorite',
  upcoming: 'upcoming',
  airing: 'airing',
  movie: 'movie',
  tv: 'tv',
  ova: 'ova',
  special: 'special',
};

// Jikan /top/anime params per slug (ranking_type and/or type filter)
const JIKAN_TOP_CATEGORIES: Record<string, { rankingType?: string; type?: string }> = {
  popular:  { rankingType: 'bypopularity' },
  trending: { rankingType: 'favorite' },
  upcoming: { rankingType: 'upcoming' },
  airing:   { rankingType: 'airing' },
  tv:       { type: 'tv' },
  movie:    { type: 'movie' },
  ova:      { type: 'ova' },
  special:  { type: 'special' },
  ona:      { type: 'ona' },
  music:    { type: 'music' },
};

// Status / recent categories → Jikan /anime filters (Jikan-only)
const JIKAN_FILTER_CATEGORIES: Record<string, {
  status?: 'airing' | 'complete' | 'upcoming';
  orderBy?: string;
  sort?: 'asc' | 'desc';
}> = {
  completed: { status: 'complete', orderBy: 'members', sort: 'desc' },
  recent:    { orderBy: 'start_date', sort: 'desc' },
};

// Niche media types with no MAL search filter at all (documented limitation)
const UNSUPPORTED_CATEGORIES = new Set(['tvshort', 'cm', 'pv']);

const SEASON_REGEX = /^(spring|summer|fall|winter)-(\d{4})$/i;

interface CategoryResult {
  data: any[];
  hasNextPage: boolean;
  backend: 'jikan' | 'mal';
  note?: string;
}

async function fetchCategory(category: string, page: number): Promise<CategoryResult | null> {
  const slug = category.toLowerCase();
  const offset = (page - 1) * PER_PAGE;

  // --- GROUP A: ranking categories — Jikan /top/anime → MAL /anime/ranking ---
  if (JIKAN_TOP_CATEGORIES[slug]) {
    const jf = JIKAN_TOP_CATEGORIES[slug];
    try {
      const r: JikanBrowseResult = await getTopAnime({
        rankingType: jf.rankingType,
        type: jf.type,
        page,
        limit: PER_PAGE,
      });
      return { data: r.data, hasNextPage: r.hasNextPage, backend: 'jikan' };
    } catch (jikanErr) {
      console.warn(`[category:${slug}] Jikan /top/anime failed:`, jikanErr instanceof Error ? jikanErr.message : jikanErr);
    }

    // Official MAL fallback — only for slugs with a MAL ranking_type.
    // (ona/music have no MAL ranking type; if Jikan failed there is
    // nothing else to try.)
    if (RANKING_CATEGORIES[slug]) {
      const res = await malFetch<{ data: Array<{ node: any }>; paging?: { next?: string } }>(
        '/anime/ranking',
        {
          ranking_type: RANKING_CATEGORIES[slug],
          limit: PER_PAGE,
          offset,
          fields: MAL_LIST_FIELDS,
          nsfw: 'false',
        },
        15000
      );
      return {
        data: (res.data || []).map((i) => i.node).map(transformMedia),
        hasNextPage: !!res.paging?.next,
        backend: 'mal',
      };
    }

    throw new Error(`Jikan unavailable and the official MAL API has no ranking type for "${slug}"`);
  }

  // --- GROUP A: seasons — Jikan /seasons → MAL /anime/season ---
  const seasonMatch = slug.match(SEASON_REGEX);
  if (seasonMatch) {
    const season = seasonMatch[1].toLowerCase();
    const year = parseInt(seasonMatch[2], 10);
    try {
      const r = await getSeasonAnime({ year, season, page, limit: PER_PAGE });
      return { data: r.data, hasNextPage: r.hasNextPage, backend: 'jikan' };
    } catch (jikanErr) {
      console.warn(`[category:${slug}] Jikan /seasons failed:`, jikanErr instanceof Error ? jikanErr.message : jikanErr);
    }

    const res = await malFetch<{ data: Array<{ node: any }>; paging?: { next?: string } }>(
      `/anime/season/${year}/${season}`,
      {
        limit: PER_PAGE,
        offset,
        fields: MAL_LIST_FIELDS,
        nsfw: 'false',
      },
      15000
    );
    return {
      data: (res.data || []).map((i) => i.node).map(transformMedia),
      hasNextPage: !!res.paging?.next,
      backend: 'mal',
    };
  }

  // --- GROUP B: status / recent — Jikan /anime filters (Jikan-only) ---
  if (JIKAN_FILTER_CATEGORIES[slug]) {
    const f = JIKAN_FILTER_CATEGORIES[slug];
    try {
      const r = await getFilteredAnime({
        status: f.status,
        orderBy: f.orderBy,
        sort: f.sort,
        page,
        limit: PER_PAGE,
      });
      return { data: r.data, hasNextPage: r.hasNextPage, backend: 'jikan' };
    } catch {
      throw new Error(
        `Jikan unavailable and the official MAL API cannot list "${slug}" without a search query — try again shortly`
      );
    }
  }

  // --- GROUP B: niche media types (tvshort, cm, pv) ---
  // Neither Jikan nor the official MAL API exposes a filter for these
  // media types. We attempt the Jikan passthrough once; when it returns
  // nothing (or fails) the route serves an empty page with a note
  // instead of erroring.
  if (UNSUPPORTED_CATEGORIES.has(slug)) {
    const jikanType = slug === 'tvshort' ? 'tv_short' : slug;
    try {
      const r = await getFilteredAnime({ type: jikanType, orderBy: 'members', sort: 'desc', page, limit: PER_PAGE });
      return {
        data: r.data,
        hasNextPage: r.hasNextPage,
        backend: 'jikan',
        note: `"${slug}" is not a filterable media type on Jikan or the official MAL API — an empty result means the passthrough filter is unsupported.`,
      };
    } catch (jikanErr) {
      return {
        data: [],
        hasNextPage: false,
        backend: 'jikan',
        note: `"${slug}" is not a filterable media type on Jikan or the official MAL API.`,
      };
    }
  }

  // --- GROUP B: genre-based categories (action, comedy, drama, ...) ---
  // The slug maps to a MAL genre ID via MAL_GENRE_IDS, and Jikan's
  // /anime?genres= filter works WITHOUT a search query.
  const slugNoDash = slug.replace(/-/g, '');
  const malGenreId = MAL_GENRE_IDS[slugNoDash];
  if (malGenreId) {
    try {
      const r = await getFilteredAnime({
        genres: String(malGenreId),
        orderBy: 'members',
        sort: 'desc',
        page,
        limit: PER_PAGE,
      });
      return { data: r.data, hasNextPage: r.hasNextPage, backend: 'jikan' };
    } catch (jikanErr) {
      throw new Error(
        `Jikan unavailable and the official MAL API cannot filter genre "${slug}" without a search query — try again shortly`
      );
    }
  }

  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ category: string }> }
) {
  const { category } = await params;
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);

  if (!category) {
    return NextResponse.json(
      { success: false, error: 'Missing category' },
      { status: 400, headers: corsHeaders }
    );
  }

  const cacheKey = `cat:${category}:${page}`;
  const cached = await getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const result = await fetchCategory(category, page);

    if (result === null) {
      return NextResponse.json(
        { success: false, error: `Unknown category: ${category}` },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!result.data.length) {
      const body = { success: true, results: { data: [], totalPages: 1, backend: result.backend, note: result.note } };
      return NextResponse.json(body, { headers: corsHeaders });
    }

    const totalPages = result.hasNextPage ? page + 1 : page;

    const body = {
      success: true,
      results: {
        data: result.data,
        totalPages,
        // Surface which backend was used — useful for debugging.
        backend: result.backend,
        ...(result.note ? { note: result.note } : {}),
      },
    };

    await setCache(cacheKey, [], body, 86400); // 24 hours

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600', ...corsHeaders },
    });
  } catch (err) {
    console.error('Category error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 502, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
    );
  }
}
