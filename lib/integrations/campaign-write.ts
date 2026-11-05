// SimpleLyft fork: create, update and pause campaigns through the service API, so an outside system
// (the SimpleLyft content system) can set up a campaign when a reel goes live. Kept in its own file so
// upstream updates merge cleanly. Mirrors the dashboard's POST /api/automations rules.
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { buildInitialCampaignLinks, syncCampaignLinks } from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { ApiError } from "./http";
import { requireScope, type ServiceContext } from "./auth";

export const campaignWriteSchema = z
  .object({
    // The campaign's name is its identity for this API: writing the same name again updates it.
    name: z.string().trim().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    postId: z.string().min(1).max(100).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
    wholeWordMatch: z.boolean().optional().default(true),
    dmMessage: z.string().min(1).max(1000),
    linkButtonLabel: z.string().max(20).optional().nullable(),
    trackedDestinationUrl: z.union([z.string().url(), z.literal("")]).optional().nullable(),
    secondaryDestinationUrl: z.union([z.string().url(), z.literal("")]).optional().nullable(),
    secondaryButtonLabel: z.string().max(20).optional().nullable(),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessages: z.array(z.string().trim().min(1).max(1000)).max(10).optional().default([]),
    isActive: z.boolean().optional().default(true),
    // Follow ask. "gentle" (SimpleLyft): ask once, then send the link whether or not they followed.
    followMode: z.enum(["off", "strict", "gentle"]).optional().default("off"),
    followPromptMessage: z.string().min(1).max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    openingDmMessage: z.string().min(1).max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(20).optional().nullable(),
    followUpMessage: z.string().min(1).max(1000).optional().nullable(),
    followUpDelayMinutes: z.number().int().min(0).max(1380).optional().default(0),
  })
  .strict()
  .refine((d) => d.matchAnyPost || Boolean(d.postId), { message: "Give postId, or set matchAnyPost", path: ["postId"] })
  .refine((d) => !d.publicReplyEnabled || d.publicReplyMessages.length > 0, {
    message: "Public replies need at least one message", path: ["publicReplyMessages"],
  });

export type CampaignWrite = z.infer<typeof campaignWriteSchema>;

function fields(d: CampaignWrite) {
  return {
    name: d.name, goal: d.goal ?? null,
    postId: d.matchAnyPost ? null : d.postId ?? null,
    postUrl: d.matchAnyPost ? null : d.postUrl ?? null,
    pendingNextReel: false, matchAnyPost: d.matchAnyPost,
    keywords: d.keywords, matchAnyWord: false, wholeWordMatch: d.wholeWordMatch,
    dmMessage: d.dmMessage, linkButtonLabel: d.linkButtonLabel || null,
    publicReplyEnabled: d.publicReplyEnabled,
    publicReplyMessages: d.publicReplyEnabled ? d.publicReplyMessages : [],
    publicReplyMessage: d.publicReplyEnabled ? d.publicReplyMessages[0] ?? null : null,
    isActive: d.isActive,
    requireFollow: d.followMode !== "off", followGentle: d.followMode === "gentle",
    followPromptMessage: d.followPromptMessage ?? null, followPromptButtonLabel: d.followPromptButtonLabel || null,
    openingDmEnabled: Boolean(d.openingDmMessage && d.openingDmButtonLabel),
    openingDmMessage: d.openingDmMessage ?? null, openingDmButtonLabel: d.openingDmButtonLabel || null,
    followUpEnabled: Boolean(d.followUpMessage), followUpMessage: d.followUpMessage ?? null,
    followUpDelayMinutes: d.followUpDelayMinutes,
  };
}

async function result(workspaceId: string, id: string, created: boolean) {
  const c = await prisma.automation.findFirstOrThrow({
    where: { id, workspaceId },
    select: {
      id: true, name: true, isActive: true, postId: true, postUrl: true, matchAnyPost: true, keywords: true,
      trackedLinks: { orderBy: TRACKED_LINK_ORDER, select: { slug: true, destinationUrl: true, position: true } },
    },
  });
  return { ...c, created };
}

/** Create the campaign, or update the one with the same name in this workspace. */
export async function upsertCampaign(context: ServiceContext, input: unknown) {
  requireScope(context, "campaigns:write");
  const parsed = campaignWriteSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const d = parsed.data;
  const { workspaceId } = context;
  const account = d.instagramAccountId
    ? await prisma.instagramAccount.findFirst({ where: { id: d.instagramAccountId, workspaceId } })
    : await prisma.instagramAccount.findFirst({ where: { workspaceId }, orderBy: { connectedAt: "desc" } });
  if (!account) throw new ApiError("Connect Instagram before creating campaigns", 400);

  const existing = await prisma.automation.findFirst({
    where: { workspaceId, name: d.name }, orderBy: { createdAt: "desc" }, select: { id: true },
  });
  if (existing) {
    await prisma.$transaction(async (tx) => {
      await tx.automation.update({ where: { id: existing.id }, data: { ...fields(d), instagramAccountId: account.id } });
      await syncCampaignLinks(tx, {
        workspaceId, automationId: existing.id, primaryUrl: d.trackedDestinationUrl,
        secondaryUrl: d.secondaryDestinationUrl, secondaryLabel: d.secondaryButtonLabel,
      });
    });
    return result(workspaceId, existing.id, false);
  }
  const links = buildInitialCampaignLinks({
    workspaceId, primaryUrl: d.trackedDestinationUrl, secondaryUrl: d.secondaryDestinationUrl,
    secondaryLabel: d.secondaryButtonLabel,
  });
  const created = await prisma.automation.create({
    data: {
      ...fields(d), workspaceId, instagramAccountId: account.id, reportShareSlug: generateReportShareSlug(),
      ...(links.length ? { trackedLinks: { create: links } } : {}),
    },
    select: { id: true },
  });
  return result(workspaceId, created.id, true);
}

/** Pause or resume a campaign. */
export async function setCampaignActive(context: ServiceContext, id: string, isActive: boolean) {
  requireScope(context, "campaigns:write");
  const r = await prisma.automation.updateMany({ where: { id, workspaceId: context.workspaceId }, data: { isActive } });
  if (!r.count) throw new ApiError("Campaign not found", 404);
  return result(context.workspaceId, id, false);
}
