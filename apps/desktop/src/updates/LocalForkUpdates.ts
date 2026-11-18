import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Electron from "electron";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hash each streamed download chunk without buffering a DMG in memory.
import * as NodeCrypto from "node:crypto";

const RELEASE_URL = "https://api.github.com/repos/RudenkoAD/t3code/releases/latest";
const RELEASE_ASSET_PREFIX = "https://github.com/RudenkoAD/t3code/releases/download/";

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      digest: Schema.NullOr(Schema.String),
      browser_download_url: Schema.String,
    }),
  ),
});
type GitHubRelease = typeof GitHubRelease.Type;

export type LocalForkUpdate = {
  readonly status: "available";
  readonly currentVersion: string;
  readonly version: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly size: number;
  readonly digest: string;
};

export type LocalForkUpdateCheck =
  | LocalForkUpdate
  | {
      readonly status: "up-to-date";
      readonly currentVersion: string;
      readonly latestVersion: string;
    }
  | { readonly status: "error"; readonly message: string };

export type LocalForkUpdateDownload =
  | { readonly status: "downloaded"; readonly path: string }
  | { readonly status: "cancelled" }
  | { readonly status: "error"; readonly message: string };

export function resolveLocalForkUpdate(input: {
  readonly currentVersion: string;
  readonly architecture: string;
  readonly release: GitHubRelease;
}): LocalForkUpdateCheck {
  const currentVersion = input.currentVersion.replace(/-local-fork$/, "");
  const tagVersion = /^local-fork-v(\d+\.\d+\.\d+)$/.exec(input.release.tag_name)?.[1];
  if (
    !tagVersion ||
    parseSemver(tagVersion) === null ||
    !input.release.html_url.startsWith("https://github.com/RudenkoAD/t3code/releases/tag/")
  ) {
    return {
      status: "error",
      message: "The latest GitHub release is not a stable RudenkoAD/t3code fork build.",
    };
  }
  if (!input.currentVersion.endsWith("-local-fork") || parseSemver(currentVersion) === null) {
    return { status: "error", message: "This local fork has an invalid version number." };
  }
  if (input.architecture !== "arm64" && input.architecture !== "x64") {
    return { status: "error", message: `No macOS DMG is available for ${input.architecture}.` };
  }
  if (compareSemverVersions(tagVersion, currentVersion) <= 0) {
    return { status: "up-to-date", currentVersion, latestVersion: tagVersion };
  }

  const assetName = `T3-Code-${tagVersion}-local-fork-${input.architecture}.dmg`;
  const asset = input.release.assets.find((candidate) => candidate.name === assetName);
  const expectedDownloadUrl = `${RELEASE_ASSET_PREFIX}${input.release.tag_name}/${encodeURIComponent(assetName)}`;
  if (
    !asset ||
    asset.browser_download_url !== expectedDownloadUrl ||
    asset.size <= 0 ||
    !/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? "")
  ) {
    return {
      status: "error",
      message: `The ${input.architecture} DMG for local fork version ${tagVersion} is not available.`,
    };
  }
  return {
    status: "available",
    currentVersion,
    version: tagVersion,
    tag: input.release.tag_name,
    releaseUrl: input.release.html_url,
    assetName,
    downloadUrl: asset.browser_download_url,
    size: asset.size,
    digest: asset.digest!,
  };
}

export class LocalForkUpdates extends Context.Service<
  LocalForkUpdates,
  {
    readonly check: (input: {
      readonly currentVersion: string;
      readonly architecture: string;
    }) => Effect.Effect<LocalForkUpdateCheck>;
    readonly download: (update: LocalForkUpdate) => Effect.Effect<LocalForkUpdateDownload>;
  }
>()("@t3tools/desktop/updates/LocalForkUpdates") {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "An unexpected error occurred.";

class LocalForkReleaseFetchError extends Schema.TaggedError<LocalForkReleaseFetchError>()(
  "LocalForkReleaseFetchError",
  { message: Schema.String },
) {}

class LocalForkDownloadError extends Schema.TaggedError<LocalForkDownloadError>()(
  "LocalForkDownloadError",
  { message: Schema.String },
) {}

const isLocalForkReleaseFetchError = Schema.is(LocalForkReleaseFetchError);
const isLocalForkDownloadError = Schema.is(LocalForkDownloadError);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return LocalForkUpdates.of({
    check: Effect.fn("desktop.localForkUpdates.check")(function* (input) {
      const release = yield* Effect.tryPromise({
        try: async () => {
          const response = await Electron.net.fetch(RELEASE_URL, {
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "T3-Code-Desktop",
            },
          });
          if (!response.ok) {
            throw new LocalForkReleaseFetchError({
              message: `GitHub returned HTTP ${response.status}.`,
            });
          }
          return await response.json();
        },
        catch: (cause) =>
          isLocalForkReleaseFetchError(cause)
            ? cause
            : new LocalForkReleaseFetchError({
                message: `Could not reach GitHub Releases: ${errorMessage(cause)}`,
              }),
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GitHubRelease)), Effect.result);
      if (release._tag === "Failure") {
        return {
          status: "error",
          message: `Could not check RudenkoAD/t3code GitHub Releases: ${release.failure.message}`,
        } as const;
      }
      return resolveLocalForkUpdate({ ...input, release: release.success });
    }),
    download: Effect.fn("desktop.localForkUpdates.download")(function* (update) {
      const randomSuffix = yield* Random.nextIntBetween(0, 0x7fffffff);
      const destination = yield* Effect.tryPromise({
        try: () =>
          Electron.dialog.showSaveDialog({
            title: `Save T3 Code ${update.version} DMG`,
            defaultPath: path.join(Electron.app.getPath("downloads"), update.assetName),
            filters: [{ name: "Disk Image", extensions: ["dmg"] }],
          }),
        catch: (cause) =>
          new LocalForkDownloadError({
            message: `Could not open the save dialog: ${errorMessage(cause)}`,
          }),
      }).pipe(Effect.result);
      if (destination._tag === "Failure") {
        return { status: "error", message: destination.failure.message } as const;
      }
      if (destination.success.canceled) return { status: "cancelled" } as const;

      const filePath = destination.success.filePath;
      const temporaryPath = `${filePath}.${randomSuffix}.download`;
      const operation = Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () => Electron.net.fetch(update.downloadUrl),
          catch: (cause) =>
            new LocalForkDownloadError({
              message: `Could not reach GitHub: ${errorMessage(cause)}`,
            }),
        });
        if (!response.ok) {
          return yield* new LocalForkDownloadError({
            message: `GitHub returned HTTP ${response.status}.`,
          });
        }
        if (response.body === null) {
          return yield* new LocalForkDownloadError({
            message: "GitHub returned an empty download.",
          });
        }
        const writtenBytes = yield* Ref.make(0);
        const hash = NodeCrypto.createHash("sha256");
        const body = Stream.fromReadableStream({
          evaluate: () => response.body!,
          onError: (cause) =>
            new LocalForkDownloadError({
              message: `The GitHub download was interrupted: ${errorMessage(cause)}`,
            }),
        });
        yield* body.pipe(
          Stream.tap((chunk) =>
            Ref.update(writtenBytes, (total) => total + chunk.length).pipe(
              Effect.andThen(Effect.sync(() => hash.update(chunk))),
              Effect.asVoid,
            ),
          ),
          Stream.run(fileSystem.sink(temporaryPath, { flag: "wx" })),
          Effect.mapError((cause) =>
            isLocalForkDownloadError(cause)
              ? cause
              : new LocalForkDownloadError({
                  message: `Could not save the DMG: ${errorMessage(cause)}`,
                }),
          ),
        );
        const actualSize = yield* Ref.get(writtenBytes);
        if (actualSize !== update.size) {
          return yield* new LocalForkDownloadError({ message: "The DMG download was incomplete." });
        }
        if (`sha256:${hash.digest("hex")}`.toLowerCase() !== update.digest.toLowerCase()) {
          return yield* new LocalForkDownloadError({
            message: "The DMG download failed verification.",
          });
        }
        yield* fileSystem.rename(temporaryPath, filePath).pipe(
          Effect.mapError(
            (cause) =>
              new LocalForkDownloadError({
                message: `Could not finish saving the DMG: ${errorMessage(cause)}`,
              }),
          ),
        );
        return filePath;
      });
      const result = yield* Effect.result(operation);
      if (result._tag === "Failure") {
        yield* fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore);
        return {
          status: "error",
          message: isLocalForkDownloadError(result.failure)
            ? result.failure.message
            : errorMessage(result.failure),
        } as const;
      }
      Electron.shell.showItemInFolder(result.success);
      return { status: "downloaded", path: result.success } as const;
    }),
  });
});

export const layer = Layer.effect(LocalForkUpdates, make);
