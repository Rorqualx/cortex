/**
 * Startup gate: every registered core handler must carry a policy descriptor.
 *
 * This lives in its own file on purpose. The same invariant is exercised inside
 * server-methods-list.test.ts, but that file also asserts advertised method
 * ordering; when an ordering assertion is red the whole file is already in the
 * failing set, and a file-granular regression gate (remote-proof.sh diffs
 * failing FILES, not cases) stops reporting anything new inside it. On
 * 2026-08-03 that masked two handlers with no descriptor, the merge landed
 * green, and the gateway crash-looped on boot with
 * "gateway method handler is missing a descriptor: skills.proposals.events.list".
 *
 * Keep this file free of any other assertion so it stays green, and so a
 * missing descriptor shows up as a newly failing file rather than one more
 * failure in a file that was already red.
 */
import { describe, expect, it } from "vitest";
import { coreGatewayHandlers } from "../server-methods.js";
import { isCoreGatewayMethodClassified } from "./core-descriptors.js";

describe("core gateway method descriptor coverage", () => {
  it("classifies every registered core handler", () => {
    const unclassified = Object.keys(coreGatewayHandlers)
      .filter((name) => !isCoreGatewayMethodClassified(name))
      .sort();

    // Named rather than counted: createCoreGatewayMethodDescriptors throws on the
    // first unclassified handler at startup, so the message has to list all of
    // them or each boot attempt only reveals one.
    expect(unclassified).toEqual([]);
  });
});
