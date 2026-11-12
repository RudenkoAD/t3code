import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ProjectProfileSelector } from "./ProjectProfileSelector";
import { profileViewIncludesMembers } from "../projectProfileView";
import { ProfileNativeProvidersSettings } from "./settings/ProfileNativeProvidersSettings";
import { ProfileSettingsEntry } from "./settings/ProfileSettingsEntry";

const settingsMocks = vi.hoisted(() => ({ update: vi.fn() }));
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
    .element(screen.getByText(/CODEX_HOME='\/var\/lib\/t3\/profiles\/work\/codex'/))
    .toBeVisible();
  await expect
    .element(screen.getByText(/CLAUDE_CONFIG_DIR='\/var\/lib\/t3\/profiles\/work\/claude'/))
    .toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Codex MCP docs" })).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Claude Code MCP docs" })).toBeVisible();
});
