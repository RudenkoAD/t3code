import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  canManage: true,
  profile: "work" as "work" | "personal",
  mismatch: false,
  reads: vi.fn(async (_request: { environmentId: string; input: { projectId: string } }) => ({
    _tag: "Success" as const,
    value: {
      projectId: "project-a",
      profile: state.mismatch ? (state.profile === "work" ? "personal" : "work") : state.profile,
      providerEnabled: { codex: true, claude: true },
      mcpServers: [
        { name: "shared-server", provider: "codex", source: "profile", enabled: true },
        { name: "profile-off", provider: "codex", source: "profile", enabled: false },
        { name: "project-off", provider: "codex", source: "project", enabled: false },
      ],
      skills: [],
      providerStatus: { codex: "configured", claude: "missing" },
      skillsStatus: { codex: "available", claude: "unavailable" },
    },
  })),
  writes: vi.fn(async (_request: { environmentId: string; input: { patch: unknown } }) => ({
    _tag: "Success" as const,
    value: undefined,
  })),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: () => ({
    projectProfiles: { "project-a": state.profile },
    projectSettingsOverrides: {
      "project-a": {
        profileToolAccess: {
          work: { mcpServers: { codex: { "shared-server": true, "retired-server": true } } },
          personal: { mcpServers: { codex: {} } },
        },
      },
    },
  }),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === AuthProvidersManageScope || (scope === AuthSettingsWriteScope && state.canManage),
  readEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === AuthProvidersManageScope || (scope === AuthSettingsWriteScope && state.canManage),
}));
vi.mock("~/state/use-atom-command", async () => {
  const { serverEnvironment } = await import("~/state/server");
  return {
    useAtomCommand: (command: unknown) =>
      command === serverEnvironment.projectToolsInventory ? state.reads : state.writes,
  };
});

import { ProjectToolAccessSettings } from "./ProjectToolAccessSettings";

describe("ProjectToolAccessSettings", () => {
  it("shows a project denial, disables inherited profile-off rows, and gates writes for read-only users", async () => {
    state.canManage = true;
    state.profile = "work";
    state.mismatch = false;
    state.reads.mockClear();
    state.writes.mockClear();
    await using stack = new AsyncDisposableStack();
    stack.use(
      await render(
        <ProjectToolAccessSettings
          projects={[
            {
              id: ProjectId.make("project-a"),
              environmentId: EnvironmentId.make("env-a"),
              workspaceRoot: "/work/a",
              environmentLabel: "Workstation",
            },
          ]}
        />,
      ),
    );
    await expect.element(page.getByText("Disabled for this project").first()).toBeVisible();
    await expect.element(page.getByText("retired-server")).toBeVisible();
    await expect.element(page.getByText("No longer configured · project override")).toBeVisible();
    await expect.element(page.getByText("Disabled in project configuration")).toBeVisible();
    await page.getByRole("button", { name: "Inherit" }).last().click();
    await vi.waitFor(() => expect(state.writes).toHaveBeenCalledTimes(1));
    await expect.element(page.getByRole("button", { name: "Inherit" }).last()).not.toBeDisabled();
    const deniedToggle = page.getByRole("switch", { name: "shared-server enabled" }).query();
    expect(deniedToggle).not.toBeNull();
    expect(deniedToggle?.getAttribute("aria-checked")).toBe("false");
    if (!(deniedToggle instanceof HTMLElement)) throw new Error("Expected a switch element");
    await act(async () => deniedToggle.click());
    await vi.waitFor(() => expect(state.writes).toHaveBeenCalledTimes(2));
    expect(state.writes.mock.calls[0]?.[0]).toMatchObject({
      input: {
        patch: {
          projectProfileToolAccessOverrides: {
            "project-a": {
              work: { mcpServers: { codex: { "retired-server": null } } },
            },
          },
        },
      },
    });
    expect(state.writes.mock.calls[1]?.[0]).toMatchObject({
      input: {
        patch: {
          projectProfileToolAccessOverrides: {
            "project-a": {
              work: { mcpServers: { codex: { "shared-server": null } } },
            },
          },
        },
      },
    });
  });

  it("does not expose another profile's denial and keeps controls read-only without permission", async () => {
    state.canManage = false;
    state.profile = "personal";
    state.mismatch = false;
    state.writes.mockClear();
    await using stack = new AsyncDisposableStack();
    stack.use(
      await render(
        <ProjectToolAccessSettings
          projects={[
            {
              id: ProjectId.make("project-a"),
              environmentId: EnvironmentId.make("env-a"),
              workspaceRoot: "/work/a",
              environmentLabel: "Workstation",
            },
          ]}
        />,
      ),
    );
    await expect.element(page.getByText("Inherits profile setting").first()).toBeVisible();
    const toggle = page.getByRole("switch", { name: "shared-server enabled" }).last();
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    await expect.element(toggle).toBeDisabled();
    await expect.element(page.getByRole("switch", { name: "profile-off enabled" })).toBeDisabled();
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("requires an explicit checkout choice when a project spans checkouts", async () => {
    state.canManage = true;
    state.profile = "work";
    state.mismatch = false;
    state.reads.mockClear();
    await using stack = new AsyncDisposableStack();
    stack.use(
      await render(
        <ProjectToolAccessSettings
          projects={[
            {
              id: ProjectId.make("project-a"),
              environmentId: EnvironmentId.make("env-a"),
              workspaceRoot: "/work/a",
              environmentLabel: "Workstation",
            },
            {
              id: ProjectId.make("project-b"),
              environmentId: EnvironmentId.make("env-b"),
              workspaceRoot: "/work/b",
              environmentLabel: "Remote",
            },
          ]}
        />,
      ),
    );
    await expect
      .element(page.getByText("Choose a checkout to manage its inherited tools."))
      .toBeVisible();
    expect(state.reads).not.toHaveBeenCalled();
    await page.getByRole("combobox", { name: "Tools checkout" }).click();
    await page.getByRole("option", { name: "Remote · /work/b" }).click();
    await vi.waitFor(() => expect(state.reads).toHaveBeenCalledTimes(1));
    expect(state.reads.mock.calls[0]?.[0]).toMatchObject({
      environmentId: EnvironmentId.make("env-b"),
      input: { projectId: ProjectId.make("project-b") },
    });
  });

  it("does not render an inventory resolved for a different current profile", async () => {
    state.canManage = true;
    state.profile = "work";
    state.mismatch = true;
    state.reads.mockClear();
    await using stack = new AsyncDisposableStack();
    stack.use(
      await render(
        <ProjectToolAccessSettings
          projects={[
            {
              id: ProjectId.make("project-a"),
              environmentId: EnvironmentId.make("env-a"),
              workspaceRoot: "/work/a",
              environmentLabel: "Workstation",
            },
          ]}
        />,
      ),
    );
    await expect
      .element(page.getByText("Could not load or save project tools. Check access and try again."))
      .toBeVisible();
    await expect
      .element(page.getByText("Project override · list not loaded").first())
      .toBeVisible();
    expect(page.getByText("No longer configured").query()).toBeNull();
  });
});
