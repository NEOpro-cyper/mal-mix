import { NextRequest, NextResponse } from 'next/server';
import { fetchMiruroEpisodes, buildServerList, filterByEpisode } from '@/lib/miruro';
import { parseSlug } from '@/lib/mal';
import { resolveAnilistId } from '@/lib/jikan';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

// GET /api/servers/[id]?ep=X
// GET /api/servers/[id]
//
// [id] can be a MAL ID or slug ending with a MAL ID.
// We resolve MAL→AniList via Jikan's /anime/{id}/external endpoint,
// then call Miruro.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Missing anime ID in path' },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const parsed = parseSlug(id);
    let malId: number | null = null;

    if (parsed) {
      malId = parsed.malId;
    } else if (!isNaN(Number(id))) {
      // Plain numeric — assume MAL ID (most common case for the path-based route)
      malId = Number(id);
    }

    if (malId === null) {
      return NextResponse.json(
        { success: false, error: 'Invalid anime ID — must be a numeric MAL ID or slug ending with numeric ID' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Resolve MAL → AniList via Jikan /external
    const anilistId = await resolveAnilistId(malId);
    if (!anilistId) {
      return NextResponse.json(
        {
          success: false,
          error: 'No AniList ID found for this MAL ID. MAL\'s external-links sidebar has no AniList entry for this anime — Miruro (which requires AniList IDs) cannot be queried.',
          debug: { malId, note: 'Jikan /anime/{id}/external returned no AniList link.' },
        },
        { status: 404, headers: corsHeaders }
      );
    }

    const { searchParams } = new URL(request.url);
    const epParam = searchParams.get('ep');
    const epNum = epParam ? parseInt(epParam, 10) : 0;

    const data = await fetchMiruroEpisodes(String(anilistId));
    const built = buildServerList(data);
    const result = epNum > 0 ? filterByEpisode(built, epNum) : built;

    if (!result.results || result.results.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'No servers available',
          debug: { anilistId, malId, note: 'Miruro returned data but no kiwi/hop episodes found' },
        },
        { status: 404, headers: corsHeaders }
      );
    }

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600', ...corsHeaders },
    });
  } catch (err) {
    console.error('Servers error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
    );
  }
}
