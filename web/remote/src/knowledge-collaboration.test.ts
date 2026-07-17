import { describe, expect, it } from "vitest";
import { setMarketplaceTrust } from "./knowledge-collaboration";
import type { Identity } from "./types";

const creator: Identity = { sub:"creator", email:"creator@example.com" };
const reviewer: Identity = { sub:"reviewer", email:"reviewer@example.com" };

describe("marketplace executable trust", () => {
  it("rejects creator self-approval even when the creator is an organization admin", async () => {
    const db = marketplaceDatabase({ owner_sub:creator.sub, organization_id:"org_1", kind:"plugin" }, { creator:"admin" });
    await expect(setMarketplaceTrust(db, creator, "market_1", "approved")).rejects.toThrow(/admin other than their creator/);
    expect(db.trustStatus).toBe("pending");
  });

  it("requires an independent organization admin to approve executable items", async () => {
    const nonAdminDb = marketplaceDatabase({ owner_sub:creator.sub, organization_id:"org_1", kind:"hook" }, { reviewer:"developer" });
    await expect(setMarketplaceTrust(nonAdminDb, reviewer, "market_1", "approved")).rejects.toThrow(/Organization admin role is required/);
    expect(nonAdminDb.trustStatus).toBe("pending");

    const adminDb = marketplaceDatabase({ owner_sub:creator.sub, organization_id:"org_1", kind:"mcp" }, { reviewer:"admin" });
    await expect(setMarketplaceTrust(adminDb, reviewer, "market_1", "approved")).resolves.toEqual({ id:"market_1", trustStatus:"approved" });
    expect(adminDb.trustStatus).toBe("approved");
  });

  it("does not allow a personal executable item to bypass independent review", async () => {
    const db = marketplaceDatabase({ owner_sub:creator.sub, organization_id:null, kind:"plugin" });
    await expect(setMarketplaceTrust(db, creator, "market_1", "approved")).rejects.toThrow(/independent organization-admin approval/);
    expect(db.trustStatus).toBe("pending");
  });

  it("retains creator moderation for non-executable items and rejection", async () => {
    const ruleDb = marketplaceDatabase({ owner_sub:creator.sub, organization_id:null, kind:"rule" });
    await expect(setMarketplaceTrust(ruleDb, creator, "market_1", "approved")).resolves.toMatchObject({ trustStatus:"approved" });

    const pluginDb = marketplaceDatabase({ owner_sub:creator.sub, organization_id:"org_1", kind:"plugin" });
    await expect(setMarketplaceTrust(pluginDb, creator, "market_1", "rejected")).resolves.toMatchObject({ trustStatus:"rejected" });
  });
});

type MarketplaceItem = { owner_sub:string; organization_id:string|null; kind:string };
type OrganizationRole = "owner" | "admin" | "developer" | "reviewer" | "viewer";

function marketplaceDatabase(item: MarketplaceItem, roles: Record<string, OrganizationRole> = {}) {
  const state = { trustStatus:"pending" };
  const db = {
    get trustStatus() { return state.trustStatus; },
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) { values = input; return statement; },
        async first() {
          if (sql.includes("FROM marketplace_items")) return values[0] === "market_1" ? item : null;
          if (sql.includes("FROM organization_memberships")) {
            const role = roles[String(values[1])];
            return role ? { role, status:"active" } : null;
          }
          return null;
        },
        async run() {
          if (!sql.startsWith("UPDATE marketplace_items") || values[2] !== "market_1") return { meta:{ changes:0 } };
          state.trustStatus = String(values[0]);
          return { meta:{ changes:1 } };
        },
      };
      return statement;
    },
  };
  return db as typeof db & D1Database;
}
