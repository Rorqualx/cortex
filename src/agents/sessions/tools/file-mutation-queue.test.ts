import { describe, expect, it } from "vitest";
import { withFileMutationQueueKeyResolution } from "./file-mutation-queue.js";

describe("withFileMutationQueueKeyResolution", () => {
  it("rejects once without leaving the key resolution unhandled when the target path is refused", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const target = Promise.reject(new Error("Path escapes sandbox root"));
      await expect(
        withFileMutationQueueKeyResolution(
          target.then(() => "key"),
          async () => "written",
          { toolName: "apply_patch", filePaths: target.then(() => ["/outside/file"]) },
        ),
      ).rejects.toThrow("Path escapes sandbox root");
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
