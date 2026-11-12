import type { ProjectProfile } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { profileProviderHomeDirectory } from "./profileProviderHome.ts";

it.effect("keeps each profile's native provider homes separate", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const profiles = path.join("/t3", "profiles");
    const profilesByScope: ReadonlyArray<ProjectProfile> = ["work", "personal"];
    const homes = profilesByScope.flatMap((profile) =>
      (["codex", "claude"] as const).map((provider) =>
        profileProviderHomeDirectory(path, profiles, profile, provider),
      ),
    );

    expect(new Set(homes).size).toBe(4);
    expect(homes).toEqual([
      path.join(profiles, "work", "codex"),
      path.join(profiles, "work", "claude"),
      path.join(profiles, "personal", "codex"),
      path.join(profiles, "personal", "claude"),
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
