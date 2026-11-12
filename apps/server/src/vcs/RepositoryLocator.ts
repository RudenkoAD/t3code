import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface RepositoryMarker {
  readonly kind: "arc" | "git";
  readonly rootPath: string;
  readonly metadataPath: string;
}

/** Point-walks repository markers without enumerating directories. Nearest marker wins. */
export const locateRepositoryMarker = Effect.fn("RepositoryLocator.locateRepositoryMarker")(
  function* (cwd: string, fileSystem: FileSystem.FileSystem, path: Path.Path) {
    const lexicalPath = path.resolve(cwd);
    const startPath = yield* fileSystem
      .realPath(lexicalPath)
      .pipe(Effect.orElseSucceed(() => lexicalPath));
    let current = startPath;
    while (true) {
      const gitMetadataPath = path.join(current, ".git");
      if (yield* fileSystem.exists(gitMetadataPath).pipe(Effect.orElseSucceed(() => false))) {
        return { kind: "git" as const, rootPath: current, metadataPath: gitMetadataPath };
      }

      const arcMetadataPath = path.join(current, ".arcadia.root");
      if (yield* fileSystem.exists(arcMetadataPath).pipe(Effect.orElseSucceed(() => false))) {
        return { kind: "arc" as const, rootPath: current, metadataPath: arcMetadataPath };
      }

      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  },
);
