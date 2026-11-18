import {
  ProfileMcpServerToggleError,
  type ProfileSetMcpServerEnabledInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { lock } from "proper-lockfile";
import { setClaudeMcpEnabled } from "./profileClaudeMcpConfig.ts";
import { setCodexMcpEnabled } from "./profileCodexMcpConfig.ts";

type Reason = ProfileMcpServerToggleError["reason"];
const failure = (reason: Reason) => new ProfileMcpServerToggleError({ reason });

/** Resolve relative to the canonical state root so a link into another profile cannot change it. */
const resolveConfig = Effect.fn("ProfileMcp.resolveConfig")(function* (
  directory: string,
  input: ProfileSetMcpServerEnabledInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(directory);
  const home = path.join(root, input.scope, input.provider);
  if ((yield* fs.realPath(home)) !== home) return yield* failure("linked_config");
  const filename = input.provider === "codex" ? "config.toml" : ".claude.json";
  const target = yield* fs.realPath(path.join(home, filename));
  const relative = path.relative(home, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return yield* failure("linked_config");
  }
  return target;
});

export const updateProfileMcpConfig = Effect.fn("ProfileMcp.updateConfig")(
  function* (input: ProfileSetMcpServerEnabledInput, directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = yield* resolveConfig(directory, input);
    if ((yield* fs.stat(target)).type !== "File") return yield* failure("invalid_config");
    // Concurrent desktop/server clients must read the most recent file *after* acquiring the lease.
    // The CLI can also edit the file independently, so verify its contents again before replacing it.
    let compromised = false;
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          lock(target, {
            lockfilePath: `${target}.t3-mcp.lock`,
            retries: { retries: 8, minTimeout: 20, maxTimeout: 150 },
            onCompromised: () => {
              compromised = true;
            },
          }),
        catch: (err) =>
          failure((err as NodeJS.ErrnoException)?.code === "ELOCKED" ? "conflict" : "write_failed"),
      }),
      (unlock) =>
        Effect.tryPromise({ try: () => unlock(), catch: () => failure("write_failed") }).pipe(
          Effect.ignore,
        ),
    );
    const content = yield* fs.readFileString(target);
    const change = input.provider === "codex" ? setCodexMcpEnabled : setClaudeMcpEnabled;
    const result = change(content, input.name, input.enabled);
    if (!result.ok) {
      const reason: Reason =
        result.reason === "server-not-found"
          ? "missing_server"
          : result.reason === "invalid-config"
            ? "invalid_config"
            : "unsupported_layout";
      return yield* failure(reason);
    }
    if (result.content === content) return;
    const info = yield* fs.stat(target);
    if ((info.mode & 0o200) === 0) return yield* failure("write_failed");
    const stage = yield* fs.makeTempDirectoryScoped({
      directory: path.dirname(target),
      prefix: ".t3-mcp-",
    });
    const temp = path.join(stage, "config.tmp");
    yield* fs.writeFileString(temp, result.content, { flag: "wx", mode: 0o600 });
    if (
      (yield* resolveConfig(directory, input)) !== target ||
      (yield* fs.readFileString(target)) !== content ||
      compromised
    ) {
      return yield* failure("conflict");
    }
    yield* fs.rename(temp, target);
  },
  Effect.scoped,
  Effect.mapError((error) =>
    error._tag === "ProfileMcpServerToggleError"
      ? error
      : failure(error.reason._tag === "NotFound" ? "missing_server" : "write_failed"),
  ),
);
