import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId } from "@t3tools/contracts";

import { render } from "../../test/render";
import { ProjectProfileSelector } from "./ProjectProfileSelector";
import { profileForNewProject, profileViewIncludesMembers } from "../projectProfileView";
import { ProfileNativeProvidersSettings } from "./settings/ProfileNativeProvidersSettings";
import { ProfileSettingsEntry } from "./settings/ProfileSettingsEntry";

const settingsMocks = vi.hoisted(() => ({ update: vi.fn(), readInventory: vi.fn() }));
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
  useAtomCommand: (() => settingsMocks.readInventory) as never,
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
  await using screen = await render(
    <ProfileNativeProvidersSettings
      profile="personal"
      environmentId={EnvironmentId.make("environment-test")}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await expect.element(screen.getByText("local-tools")).toBeVisible();
  await expect.element(screen.getByText("Disabled")).toBeVisible();
  await expect.element(screen.getByText("No MCP servers configured")).toBeVisible();
  expect(settingsMocks.readInventory).toHaveBeenCalledWith({
    environmentId: "environment-test",
    input: { scope: "personal" },
  });
});

it("does not query an arbitrary environment when none is selected", async () => {
  settingsMocks.readInventory.mockReset();
  await using screen = await render(<ProfileNativeProvidersSettings profile="work" />);

  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await expect
    .element(screen.getByText("Select a connected environment to inspect its profile."))
    .toBeVisible();
  expect(settingsMocks.readInventory).not.toHaveBeenCalled();
});
