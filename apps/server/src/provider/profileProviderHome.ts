import type { ProjectProfile } from "@t3tools/contracts";
import type * as Path from "effect/Path";

export type ProfileNativeProvider = "codex" | "claude";

/** Native CLI homes under T3 state, isolated by profile and provider. */
export const profileProviderHomeDirectory = (
  path: Path.Path,
  profileHomeDirectory: string,
  profile: ProjectProfile,
  provider: ProfileNativeProvider,
): string => path.join(profileHomeDirectory, profile, provider);
