import { NextRequest, NextResponse } from 'next/server';
import { parseSlug } from '@/lib/mal';
import { getCharacters, getCached, setCache } from '@/lib/jikan';
import { malFetch } from '@/lib/mal';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

function resolveId(searchParams: URLSearchParams): { malId: number; cacheKey: string } | null {
  const raw = searchParams.get('id') || searchParams.get('malId') || searchParams.get('anilistId') || '';
  if (!raw) return null;

  if (searchParams.has('malId')) {
    const n = parseInt(raw, 10);
    return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `chars:mal:${n}` } : null;
  }
  if (searchParams.has('anilistId')) {
    // Legacy param — this codebase keys everything by MAL ID now, so treat
    // it as a MAL ID with a separate cache key (same behavior as before).
    const n = parseInt(raw, 10);
    return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `chars:al:${n}` } : null;
  }

  const parsed = parseSlug(raw);
  if (parsed) return { malId: parsed.malId, cacheKey: `chars:slug:${raw}` };

  const n = parseInt(raw, 10);
  return (!isNaN(n) && n > 0) ? { malId: n, cacheKey: `chars:num:${n}` } : null;
}

// GET /api/characters?id=attack-on-titan-16498&page=1
// GET /api/characters?malId=16498
//
// The official MAL API v2 doesn't expose characters/voice actors (the endpoint
// was removed in 2019). Jikan fills the gap: GET /anime/{id}/characters
// returns the full character list with voice actors per character. We filter
// voice actors to Japanese and paginate client-side (25/page) to keep the
// response shape identical to the old AniList-based implementation.
//
// PRIMARY: Jikan → FALLBACK: none (MAL API v2 has no characters endpoint —
// on Jikan failure we return an empty successful page so the UI degrades
// gracefully instead of erroring).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const resolved = resolveId(searchParams);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const PER_PAGE = 25;

  if (!resolved) {
    return NextResponse.json({ success: false, error: 'Missing or invalid id parameter' }, { status: 400, headers: corsHeaders });
  }

  const cacheKey = `${resolved.cacheKey}:${page}`;
  const cached = await getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const result = await getCharacters(resolved.malId, page, PER_PAGE);

    const body = {
      success: true,
      results: {
        data: result.edges.map((edge) => ({
          character: {
            id: edge.character?.mal_id ?? 0,
            poster: edge.character?.images?.webp?.image_url || edge.character?.images?.jpg?.image_url || '',
            name: edge.character?.name || '',
            cast: edge.role || 'Supporting',
          },
          voiceActors: (edge.voice_actors || [])
            .filter((va) => va.language === 'Japanese')
            .map((va) => ({
              id: va.person?.mal_id ?? 0,
              poster: va.person?.images?.jpg?.image_url || '',
              name: va.person?.name || '',
            })),
        })),
        pagination: {
          total: result.pageInfo.total,
          currentPage: result.pageInfo.currentPage,
          lastPage: result.pageInfo.lastPage,
          hasNextPage: result.pageInfo.hasNextPage,
          perPage: PER_PAGE,
        },
      },
    };

    await setCache(cacheKey, [], body);

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200', ...corsHeaders },
    });
  } catch (err) {
    // No other source provides characters — degrade to an empty page
    // instead of a hard 500 (keeps detail pages rendering).
    console.error('[characters] Jikan failed:', err instanceof Error ? err.message : err);

    // Double-check the anime actually exists (MAL fallback) so we can
    // tell a bad ID apart from a Jikan outage.
    try {
      await malFetch(`/anime/${resolved.malId}`, { fields: 'id' });
    } catch (malErr) {
      return NextResponse.json(
        { success: false, error: `Anime not found (malId ${resolved.malId}) — ${(malErr as Error).message}` },
        { status: 404, headers: corsHeaders }
      );
    }

    const emptyBody = {
      success: true,
      results: {
        data: [],
        pagination: { total: 0, currentPage: page, lastPage: 1, hasNextPage: false, perPage: PER_PAGE },
      },
    };
    await setCache(cacheKey, [], emptyBody, 1800); // short TTL so a Jikan recovery shows up soon
    return NextResponse.json(emptyBody, { headers: corsHeaders });
  }
}
