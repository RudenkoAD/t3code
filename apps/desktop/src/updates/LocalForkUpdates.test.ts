import { describe, expect, it } from "vite-plus/test";

import { resolveLocalForkUpdate } from "./LocalForkUpdates.ts";

const release = (version: string, architectures: ReadonlyArray<string> = ["arm64", "x64"]) => ({
  tag_name: `local-fork-v${version}`,
  html_url: `https://github.com/RudenkoAD/t3code/releases/tag/local-fork-v${version}`,
  assets: architectures.map((architecture) => ({
    name: `T3-Code-${version}-local-fork-${architecture}.dmg`,
    size: 1,
    digest: `sha256:${"a".repeat(64)}`,
    browser_download_url: `https://github.com/RudenkoAD/t3code/releases/download/local-fork-v${version}/T3-Code-${version}-local-fork-${architecture}.dmg`,
  })),
});

describe("resolveLocalForkUpdate", () => {
  it("offers the matching original DMG when a stable fork release is newer", () => {
    expect(
      resolveLocalForkUpdate({
        currentVersion: "0.1.9-local-fork",
        architecture: "arm64",
        release: release("0.1.12"),
      }),
    ).toMatchObject({
      status: "available",
      currentVersion: "0.1.9",
      version: "0.1.12",
      tag: "local-fork-v0.1.12",
      releaseUrl: "https://github.com/RudenkoAD/t3code/releases/tag/local-fork-v0.1.12",
      assetName: "T3-Code-0.1.12-local-fork-arm64.dmg",
      downloadUrl:
        "https://github.com/RudenkoAD/t3code/releases/download/local-fork-v0.1.12/T3-Code-0.1.12-local-fork-arm64.dmg",
      size: 1,
      digest: `sha256:${"a".repeat(64)}`,
    });
  });

  it("compares stable semantic versions and reports the current build", () => {
    expect(
      resolveLocalForkUpdate({
        currentVersion: "0.1.12-local-fork",
        architecture: "x64",
        release: release("0.1.12"),
      }),
    ).toEqual({ status: "up-to-date", currentVersion: "0.1.12", latestVersion: "0.1.12" });
    expect(
      resolveLocalForkUpdate({
        currentVersion: "0.1.9-local-fork",
        architecture: "x64",
        release: release("0.1.10"),
      }).status,
    ).toBe("available");
  });

  it("never falls back to an upstream or non-fork latest release", () => {
    expect(
      resolveLocalForkUpdate({
        currentVersion: "0.1.9-local-fork",
        architecture: "arm64",
        release: {
          tag_name: "v0.1.13",
          html_url: "https://github.com/RudenkoAD/t3code/releases/tag/v0.1.13",
          assets: [],
        },
      }),
    ).toMatchObject({ status: "error" });
  });

  it("reports a missing architecture DMG instead of offering the other build", () => {
    expect(
      resolveLocalForkUpdate({
        currentVersion: "0.1.9-local-fork",
        architecture: "x64",
        release: release("0.1.12", ["arm64"]),
      }),
    ).toEqual({
      status: "error",
      message: "The x64 DMG for local fork version 0.1.12 is not available.",
    });
  });
});
