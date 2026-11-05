/** Client-safe constants; do not import the database into client components. */
// campaigns:write (SimpleLyft fork): create, update and pause campaigns through /api/v1/campaigns.
export const SERVICE_SCOPES = ["campaigns:read", "campaigns:write"] as const;
