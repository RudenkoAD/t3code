// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as RepositoryLocator from "./RepositoryLocator.ts";

it.layer(NodeServices.layer)("RepositoryLocator", (it) => {
  it.effect("resolves symlinked Arc roots and lets a nearer Git marker win", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-repository-locator-" });
      const arcRoot = path.join(temp, "arc");
      const nested = path.join(arcRoot, "quality", "offline");
      const nestedGit = path.join(nested, "personal-project");
      const alias = path.join(temp, "arc-alias");
      yield* fileSystem.makeDirectory(nestedGit, { recursive: true });
      yield* fileSystem.writeFileString(path.join(arcRoot, ".arcadia.root"), "");
      yield* fileSystem.writeFileString(path.join(nestedGit, ".git"), "gitdir: /tmp/gitdir\n");
      yield* Effect.promise(() => NodeFSP.symlink(arcRoot, alias, "dir"));
      const canonicalArcRoot = yield* fileSystem.realPath(arcRoot);
      const canonicalNestedGit = yield* fileSystem.realPath(nestedGit);

      const throughAlias = yield* RepositoryLocator.locateRepositoryMarker(
        path.join(alias, "quality", "offline"),
        fileSystem,
        path,
      );
      const personalGit = yield* RepositoryLocator.locateRepositoryMarker(
        path.join(alias, "quality", "offline", "personal-project"),
        fileSystem,
        path,
      );

      expect(throughAlias).toEqual({
        kind: "arc",
        rootPath: canonicalArcRoot,
        metadataPath: path.join(canonicalArcRoot, ".arcadia.root"),
      });
      expect(personalGit).toEqual({
        kind: "git",
        rootPath: canonicalNestedGit,
        metadataPath: path.join(canonicalNestedGit, ".git"),
      });
    }),
  );
});
