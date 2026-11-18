import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { routeProfileProviderSelection } from "./profileProviderRouting.ts";

const projectId = ProjectId.make("profile-routing-project");
const codex: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5-codex",
};

describe("routeProfileProviderSelection", () => {
  it("routes a legacy global Codex selection to the assigned profile", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectProfiles: { [projectId]: "work" as const },
    };
    expect(routeProfileProviderSelection(settings, projectId, codex)).toEqual({
      ...codex,
      instanceId: ProviderInstanceId.make("t3profile_work_codex"),
    });
  });

  it("moves a stored sibling-profile selection to the project's current profile", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectProfiles: { [projectId]: "work" as const },
    };
    expect(
      routeProfileProviderSelection(settings, projectId, {
        ...codex,
        instanceId: ProviderInstanceId.make("t3profile_personal_codex"),
      }),
    ).toEqual({ ...codex, instanceId: ProviderInstanceId.make("t3profile_work_codex") });
  });

  it("fails closed when the assigned profile has disabled the provider", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectProfiles: { [projectId]: "work" as const },
      profileProviderSettings: {
        ...DEFAULT_SERVER_SETTINGS.profileProviderSettings,
        work: { codexEnabled: false, claudeEnabled: true },
      },
    };
    expect(routeProfileProviderSelection(settings, projectId, codex)).toBeUndefined();
  });

  it("fails closed for unsupported project providers but leaves projectless context untouched", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectProfiles: { [projectId]: "work" as const },
    };
    const cursor = { ...codex, instanceId: ProviderInstanceId.make("cursor") };
    expect(routeProfileProviderSelection(settings, projectId, cursor)).toBeUndefined();
    expect(routeProfileProviderSelection(settings, null, codex)).toEqual(codex);
  });
});
