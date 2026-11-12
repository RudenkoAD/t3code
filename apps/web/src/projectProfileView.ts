import * as Schema from "effect/Schema";

import type { ProjectProfile } from "@t3tools/contracts";

import { getLocalStorageItem } from "./hooks/useLocalStorage";

export const PROJECT_PROFILE_VIEW_KEY = "t3.project-profile-view.v1";
export const ProjectProfileView = Schema.Literals(["all", "work", "personal"]);
export type ProjectProfileView = typeof ProjectProfileView.Type;

/** All profiles means new projects should use the server's location-based default. */
export function profileForNewProject(view: ProjectProfileView): ProjectProfile | undefined {
  return view === "all" ? undefined : view;
}

export function readProjectProfileView(): ProjectProfileView {
  try {
    return getLocalStorageItem(PROJECT_PROFILE_VIEW_KEY, ProjectProfileView) ?? "all";
  } catch {
    return "all";
  }
}

export function profileViewIncludesMembers(
  view: ProjectProfileView,
  memberProfiles: ReadonlyArray<"work" | "personal">,
): boolean {
  return (
    view === "all" || (memberProfiles.length > 0 && memberProfiles.every((value) => value === view))
  );
}
