import { z } from "zod";
import { authenticateService } from "@/lib/integrations/auth";
import { getCampaign, getCampaignStats, listCampaigns } from "@/lib/integrations/campaigns";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";
import { setCampaignActive, upsertCampaign } from "@/lib/integrations/campaign-write";

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id !== null && !z.string().min(1).max(100).safeParse(id).success) throw new ApiError("Invalid campaign id");
    if (url.searchParams.has("stats") && !id) throw new ApiError("Campaign id required for stats");
    const data = id ? url.searchParams.has("stats") ? await getCampaignStats(context, id) : await getCampaign(context, id) : await listCampaigns(context);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

// SimpleLyft fork: create or update a campaign (same name = update). Needs a campaigns:write key.
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const data = await upsertCampaign(context, await readJson(request));
    return Response.json({ data }, { status: data.created ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

// SimpleLyft fork: pause or resume a campaign: PATCH ?id=<campaign id> with {"isActive": false}.
export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id || !z.string().min(1).max(100).safeParse(id).success) throw new ApiError("Campaign id required");
    const body = z.object({ isActive: z.boolean() }).strict().safeParse(await readJson(request));
    if (!body.success) throw new ApiError("Body must be {\"isActive\": true|false}");
    const data = await setCampaignActive(context, id, body.data.isActive);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
