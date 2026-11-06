// SimpleLyft fork: campaign create/update/pause through the service API.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  automation: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  account: { findFirst: vi.fn() },
  sync: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    automation: state.automation, instagramAccount: state.account,
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ automation: state.automation }),
  },
}));
vi.mock("@/lib/campaigns/links", () => ({
  buildInitialCampaignLinks: ({ primaryUrl }: { primaryUrl?: string | null }) => primaryUrl ? [{ slug: "s1", destinationUrl: primaryUrl }] : [],
  syncCampaignLinks: state.sync,
}));

import { campaignWriteSchema, setCampaignActive, upsertCampaign } from "../lib/integrations/campaign-write";

const writer = { workspaceId: "ws", keyId: "k", scopes: ["campaigns:read", "campaigns:write"] };
const reader = { workspaceId: "ws", keyId: "k", scopes: ["campaigns:read"] };
const input = { name: "A-2026W44-13 V1 · LEAK", postId: "17890", postUrl: "https://www.instagram.com/reel/abc/",
  keywords: ["LEAK"], dmMessage: "Here it is 👇", trackedDestinationUrl: "https://free.simplelyftai.com/r/leak" };

beforeEach(() => {
  vi.clearAllMocks();
  state.account.findFirst.mockResolvedValue({ id: "acct" });
  state.automation.findFirstOrThrow.mockResolvedValue({ id: "c1", name: input.name, trackedLinks: [] });
});

describe("campaign write API", () => {
  it("needs the write scope", async () => {
    await expect(upsertCampaign(reader, input)).rejects.toThrow("Missing scope: campaigns:write");
  });
  it("needs a post or match-any-post, and at least one keyword", () => {
    expect(campaignWriteSchema.safeParse({ ...input, postId: undefined }).success).toBe(false);
    expect(campaignWriteSchema.safeParse({ ...input, postId: undefined, matchAnyPost: true }).success).toBe(true);
    expect(campaignWriteSchema.safeParse({ ...input, keywords: [] }).success).toBe(false);
    expect(campaignWriteSchema.safeParse({ ...input, surprise: 1 }).success).toBe(false);
  });
  it("creates a new campaign with its tracked link", async () => {
    state.automation.findFirst.mockResolvedValue(null);
    state.automation.create.mockResolvedValue({ id: "c1" });
    const r = await upsertCampaign(writer, input);
    expect(r.created).toBe(true);
    const data = state.automation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ workspaceId: "ws", instagramAccountId: "acct", keywords: ["LEAK"], matchAnyWord: false, postId: "17890" });
    expect(data.trackedLinks.create[0].destinationUrl).toBe(input.trackedDestinationUrl);
  });
  it("updates the campaign with the same name instead of duplicating it", async () => {
    state.automation.findFirst.mockResolvedValue({ id: "c1" });
    const r = await upsertCampaign(writer, { ...input, dmMessage: "New text" });
    expect(r.created).toBe(false);
    expect(state.automation.create).not.toHaveBeenCalled();
    expect(state.automation.update.mock.calls[0][0]).toMatchObject({ where: { id: "c1" }, data: { dmMessage: "New text" } });
    expect(state.sync).toHaveBeenCalledOnce();
  });
  it("account-wide keywords store no post", async () => {
    state.automation.findFirst.mockResolvedValue(null);
    state.automation.create.mockResolvedValue({ id: "c1" });
    await upsertCampaign(writer, { ...input, matchAnyPost: true });
    expect(state.automation.create.mock.calls[0][0].data).toMatchObject({ matchAnyPost: true, postId: null, postUrl: null });
  });
  it("pauses only campaigns in the key's workspace", async () => {
    state.automation.updateMany.mockResolvedValue({ count: 0 });
    await expect(setCampaignActive(writer, "other", false)).rejects.toThrow("Campaign not found");
    expect(state.automation.updateMany.mock.calls[0][0].where).toEqual({ id: "other", workspaceId: "ws" });
  });
  it("gentle follow mode asks once and keeps the opening DM and follow-up", async () => {
    state.automation.findFirst.mockResolvedValue(null);
    state.automation.create.mockResolvedValue({ id: "c1" });
    await upsertCampaign(writer, { ...input, followMode: "gentle", followPromptMessage: "Follow?", followPromptButtonLabel: "Done",
      openingDmMessage: "Here you go", openingDmButtonLabel: "Send it", followUpMessage: "Did it land?", followUpDelayMinutes: 180 });
    const data = state.automation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ requireFollow: true, followGentle: true, openingDmEnabled: true, followUpEnabled: true, followUpDelayMinutes: 180 });
    expect(campaignWriteSchema.safeParse({ ...input, followMode: "maybe" }).success).toBe(false);
  });
  it("exact match fires only when the comment is just the keyword", async () => {
    const { matchKeywords } = await import("../lib/utils/keyword-matcher");
    expect(matchKeywords("AI", ["AI"], true, true).matched).toBe(true);
    expect(matchKeywords("ai 🙏🔥", ["AI"], true, true).matched).toBe(true);
    expect(matchKeywords("AI!!", ["AI"], true, true).matched).toBe(true);
    expect(matchKeywords("AI is changing everything", ["AI"], true, true).matched).toBe(false);
    expect(matchKeywords("AI is changing everything", ["AI"], true, false).matched).toBe(true);
  });
  it("a paused campaign can wait for its reel; an active one needs a post", () => {
    const { postId, postUrl, ...noPost } = input;
    expect(campaignWriteSchema.safeParse({ ...noPost, isActive: false }).success).toBe(true);
    expect(campaignWriteSchema.safeParse({ ...noPost, isActive: true }).success).toBe(false);
  });
});
