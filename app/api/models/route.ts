import { NextResponse } from "next/server";

import { MODEL_REFRESH_SECONDS } from "@/lib/env";
import { getOpenRouterModels } from "@/lib/openrouter-models";

export const runtime = "nodejs";

export async function GET() {
  const payload = await getOpenRouterModels();

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": `public, s-maxage=${MODEL_REFRESH_SECONDS}, stale-while-revalidate=3600`,
    },
  });
}
