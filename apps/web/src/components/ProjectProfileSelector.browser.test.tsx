import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProfileMcpServerToggleError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { act, render } from "../../test/render";
import { ProjectProfileSelector } from "./ProjectProfileSelector";
import { profileForNewProject, profileViewIncludesMembers } from "../projectProfileView";
import { ProfileNativeProvidersSettings } from "./settings/ProfileNativeProvidersSettings";
import { ProfileSettingsEntry } from "./settings/ProfileSettingsEntry";

const settingsMocks = vi.hoisted(() => ({
  update: vi.fn(),
  readInventory: vi.fn(),
  setServerEnabled: vi.fn(),
  canManageProviders: true,
}));
vi.mock(import("./settings/useScopedSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useScopedSettings: (() => ({
    profileProviderSettings: {
      work: { codexEnabled: true, claudeEnabled: true },
      personal: { codexEnabled: true, claudeEnabled: true },
    },
  })) as never,
  useUpdateScopedSettings: (() => settingsMocks.update) as never,
}));
vi.mock(import("../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string }) =>
    command.label.includes("profile-mcp-inventory")
      ? settingsMocks.readInventory
      : settingsMocks.setServerEnabled) as never,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => settingsMocks.canManageProviders) as never,
}));
vi.mock(import("./settings/SettingsScopeContext"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSettingsScope: (() => ({
    environment: { serverConfig: { profileHomeDirectory: "/var/lib/t3/profiles" } },
  })) as never,
}));

it("shows only fully classified projects in a single-profile view", () => {
  expect(profileViewIncludesMembers("all", ["work", "personal"])).toBe(true);
  expect(profileViewIncludesMembers("work", ["work"])).toBe(true);
  expect(profileViewIncludesMembers("personal", ["personal", "personal"])).toBe(true);
  expect(profileViewIncludesMembers("work", ["work", "personal"])).toBe(false);
  expect(profileViewIncludesMembers("personal", [])).toBe(false);
});

it("uses automatic project assignment in All and keeps explicit profile choices", () => {
  expect(profileForNewProject("all")).toBeUndefined();
  expect(profileForNewProject("work")).toBe("work");
  expect(profileForNewProject("personal")).toBe("personal");
});

it("lets the user choose a sidebar profile filter", async () => {
  const onChange = vi.fn();
  await using screen = await render(<ProjectProfileSelector value="all" onChange={onChange} />);

  await userEvent.click(screen.getByRole("combobox", { name: "Project profile: All profiles" }));
  await userEvent.click(screen.getByRole("option", { name: "Work" }));

  expect(onChange).toHaveBeenCalledWith("work");
});

it("exposes direct Work and Personal profile settings entry points", async () => {
  const onSelect = vi.fn();
  await using screen = await render(<ProfileSettingsEntry onSelect={onSelect} />);

  await userEvent.click(screen.getByRole("button", { name: "Work tools" }));
  expect(onSelect).toHaveBeenLastCalledWith("work");
  await userEvent.click(screen.getByRole("button", { name: "Personal tools" }));
  expect(onSelect).toHaveBeenLastCalledWith("personal");
});

it("shows isolated native homes and profile-specific MCP setup commands", async () => {
  settingsMocks.update.mockReset();
  await using screen = await render(
    <ProfileNativeProvidersSettings profile="work" profileHomeDirectory="/var/lib/t3/profiles" />,
  );

  await expect.element(screen.getByText("/var/lib/t3/profiles/work/codex")).toBeVisible();
  await expect.element(screen.getByText("/var/lib/t3/profiles/work/claude")).toBeVisible();
  await expect
    .element(
      screen.getByText("CODEX_HOME='/var/lib/t3/profiles/work/codex' codex login", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByText("CLAUDE_CONFIG_DIR='/var/lib/t3/profiles/work/claude' claude auth login", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByText(
        "CODEX_HOME='/var/lib/t3/profiles/work/codex' codex mcp add my-server --url https://example.org/mcp",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByText(
        "CLAUDE_CONFIG_DIR='/var/lib/t3/profiles/work/claude' claude mcp add --transport http --scope user my-server https://example.org/mcp",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Codex MCP docs" })).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Claude Code MCP docs" })).toBeVisible();
});

it("loads only the selected profile MCP inventory and shows disabled servers", async () => {
  settingsMocks.readInventory.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      scope: "personal",
      codex: { status: "configured", servers: [{ name: "local-tools", enabled: false }] },
      claude: { status: "empty", servers: [] },
    },
  });
  settingsMocks.setServerEnabled.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      scope: "personal",
      codex: { status: "configured", servers: [{ name: "local-tools", enabled: true }] },
      claude: { status: "empty", servers: [] },
    },
  });
  await using screen = await render(
    <ProfileNativeProvidersSettings
      profile="personal"
      environmentId={EnvironmentId.make("environment-test")}
    />,
  );

  await expect.element(screen.getByText("local-tools")).toBeVisible();
  await expect.element(screen.getByText("Disabled")).toBeVisible();
  await expect.element(screen.getByText("No MCP servers configured")).toBeVisible();
  const serverSwitch = screen.getByRole("switch", { name: "Enable local-tools in Codex" });
  await act(() => (serverSwitch.element() as HTMLElement).click());
  await expect.element(screen.getByText("Enabled")).toBeVisible();
  expect(settingsMocks.setServerEnabled).toHaveBeenCalledWith({
    environmentId: "environment-test",
    input: { scope: "personal", provider: "codex", name: "local-tools", enabled: true },
  });
  settingsMocks.readInventory.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      scope: "personal",
      codex: { status: "configured", servers: [{ name: "local-tools", enabled: false }] },
      claude: { status: "empty", servers: [] },
    },
  });
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(settingsMocks.readInventory).toHaveBeenCalledTimes(2);
  await expect.element(screen.getByText("Disabled")).toBeVisible();
});

it("keeps Work inventory separate from Personal and hides controls from read-only viewers", async () => {
  settingsMocks.canManageProviders = false;
  settingsMocks.readInventory.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      scope: "work",
      codex: { status: "configured", servers: [{ name: "work-only", enabled: true }] },
      claude: { status: "empty", servers: [] },
    },
  });
  settingsMocks.setServerEnabled.mockReset();
  await using screen = await render(
    <ProfileNativeProvidersSettings
      profile="work"
      environmentId={EnvironmentId.make("environment-test")}
    />,
  );

  await expect.element(screen.getByText("work-only")).toBeVisible();
  expect(screen.container.textContent).not.toContain("local-tools");
  expect(
    screen.container.querySelector('[role="switch"][aria-label="Disable work-only in Codex"]'),
  ).toBeNull();
  expect(screen.getByRole("switch", { name: "Codex for profile" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Claude Code for profile" })).toBeDisabled();
  await expect.element(screen.getByText("Enabled")).toBeVisible();
  expect(settingsMocks.readInventory).toHaveBeenCalledWith({
    environmentId: "environment-test",
    input: { scope: "work" },
  });
  expect(settingsMocks.setServerEnabled).not.toHaveBeenCalled();
  settingsMocks.canManageProviders = true;
});

it("clears the previous profile inventory while the newly selected profile loads", async () => {
  settingsMocks.readInventory
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        scope: "personal",
        codex: { status: "configured", servers: [{ name: "personal-only", enabled: true }] },
        claude: { status: "empty", servers: [] },
      },
    })
    .mockReturnValueOnce(new Promise(() => {}));
  await using screen = await render(
    <ProfileNativeProvidersSettings
      profile="personal"
      environmentId={EnvironmentId.make("environment-test")}
    />,
  );

  await expect.element(screen.getByText("personal-only")).toBeVisible();
  await screen.rerender(
    <ProfileNativeProvidersSettings
      profile="work"
      environmentId={EnvironmentId.make("environment-test")}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Loading…" })).toBeVisible();
  expect(screen.container.textContent).not.toContain("personal-only");
});

it("shows a safe retry message after a failed switch update", async () => {
  settingsMocks.canManageProviders = true;
  settingsMocks.readInventory.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      scope: "personal",
      codex: { status: "configured", servers: [{ name: "local-tools", enabled: false }] },
      claude: { status: "empty", servers: [] },
    },
  });
  settingsMocks.setServerEnabled
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("secret-value-must-not-render")),
    })
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new ProfileMcpServerToggleError({ reason: "conflict" })),
    });
  await using screen = await render(
    <ProfileNativeProvidersSettings
      profile="personal"
      environmentId={EnvironmentId.make("environment-test")}
    />,
  );

  await expect.element(screen.getByText("local-tools")).toBeVisible();
  const retrySwitch = screen.getByRole("switch", { name: "Enable local-tools in Codex" });
  await act(() => (retrySwitch.element() as HTMLElement).click());
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not update this MCP server. Check permissions and try again.");
  expect(screen.container.textContent).not.toContain("secret-value-must-not-render");
  await act(() => (retrySwitch.element() as HTMLElement).click());
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The MCP configuration changed. Refresh and try again.");
});

it("does not query an arbitrary environment when none is selected", async () => {
  settingsMocks.readInventory.mockReset();
  await using screen = await render(<ProfileNativeProvidersSettings profile="work" />);

  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await expect
    .element(screen.getByText("Select a connected environment to inspect its profile."))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("personal-only");
});
