import { describe, expect, it } from "vitest";
import {
  TYPED_FACT_CATEGORIES,
  inferCategoryFromSlot,
  validateCategory,
  resolveCategory,
} from "./categories.js";

describe("categories", () => {
  describe("TYPED_FACT_CATEGORIES", () => {
    it("includes the core categories from the proactive memory paper", () => {
      expect(TYPED_FACT_CATEGORIES).toContain("task");
      expect(TYPED_FACT_CATEGORIES).toContain("environment");
      expect(TYPED_FACT_CATEGORIES).toContain("attempt");
      expect(TYPED_FACT_CATEGORIES).toContain("diagnosis");
      expect(TYPED_FACT_CATEGORIES).toContain("subgoal");
    });

    it("includes OpenClaw-specific categories", () => {
      expect(TYPED_FACT_CATEGORIES).toContain("infra");
      expect(TYPED_FACT_CATEGORIES).toContain("person");
      expect(TYPED_FACT_CATEGORIES).toContain("preference");
      expect(TYPED_FACT_CATEGORIES).toContain("project");
    });
  });

  describe("inferCategoryFromSlot", () => {
    it("infers infra from infra-prefixed slots", () => {
      expect(inferCategoryFromSlot("infra:pi_hole_ip")).toBe("infra");
      expect(inferCategoryFromSlot("infra:server_ip")).toBe("infra");
    });

    it("infers preference from user-prefixed slots", () => {
      expect(inferCategoryFromSlot("user:phone")).toBe("preference");
      expect(inferCategoryFromSlot("user:timezone")).toBe("preference");
    });

    it("infers person from person-prefixed slots", () => {
      expect(inferCategoryFromSlot("person:coworker_name")).toBe("person");
    });

    it("returns undefined for unknown prefixes", () => {
      expect(inferCategoryFromSlot("random:thing")).toBeUndefined();
      expect(inferCategoryFromSlot("foo_bar")).toBeUndefined();
    });

    it("infers infra from server/device/network prefixes", () => {
      expect(inferCategoryFromSlot("server:port")).toBe("infra");
      expect(inferCategoryFromSlot("device:ip")).toBe("infra");
      expect(inferCategoryFromSlot("network:ssid")).toBe("infra");
    });
  });

  describe("validateCategory", () => {
    it("accepts canonical categories case-insensitively", () => {
      expect(validateCategory("infra")).toBe("infra");
      expect(validateCategory("INFRA")).toBe("infra");
      expect(validateCategory("Task")).toBe("task");
    });

    it("rejects non-canonical values", () => {
      expect(validateCategory("random")).toBeUndefined();
      expect(validateCategory("")).toBeUndefined();
      expect(validateCategory(undefined)).toBeUndefined();
    });
  });

  describe("resolveCategory", () => {
    it("prefers explicit category when valid", () => {
      expect(resolveCategory("task", "infra:server_ip")).toBe("task");
    });

    it("falls back to slot inference when explicit is invalid", () => {
      expect(resolveCategory("garbage", "infra:server_ip")).toBe("infra");
    });

    it("falls back to slot inference when explicit is undefined", () => {
      expect(resolveCategory(undefined, "user:phone")).toBe("preference");
    });

    it("returns undefined when neither resolves", () => {
      expect(resolveCategory(undefined, "random:thing")).toBeUndefined();
    });
  });
});
