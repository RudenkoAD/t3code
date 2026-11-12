import { describe, expect, it } from "vite-plus/test";
import { SourceControlProviderKind } from "@t3tools/contracts";

import {
  getSourceControlPresentation,
  getSourceControlPresentationForKind,
} from "./sourceControlPresentation";

describe("getSourceControlPresentation", () => {
  it("presents Arcanum change requests as reviews", () => {
    const presentation = getSourceControlPresentation({
      kind: SourceControlProviderKind.make("arcanum"),
      name: "Arcanum",
      baseUrl: "https://arcanum.example",
    });

    expect(presentation.providerName).toBe("Arcanum");
    expect(presentation.terminology).toEqual({
      shortLabel: "review",
      shortLabelWithArticle: "a review",
      singular: "review",
      plural: "reviews",
    });
  });

  it("keeps Arcanum labels when resolved from its provider kind", () => {
    const presentation = getSourceControlPresentationForKind("arcanum");
    expect(presentation.providerName).toBe("Arcanum");
    expect(presentation.terminology.singular).toBe("review");
  });
});
