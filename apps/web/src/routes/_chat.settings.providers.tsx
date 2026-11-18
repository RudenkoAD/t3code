import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId, ProjectProfile } from "@t3tools/contracts";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { ProfileToolAccessSettings } from "../components/settings/ProfileToolAccessSettings";
import { ProfileNativeProvidersSettings } from "../components/settings/ProfileNativeProvidersSettings";
import { ProfileSettingsEntry } from "../components/settings/ProfileSettingsEntry";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { Button } from "../components/ui/button";
import { useNavigate } from "@tanstack/react-router";

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const navigate = useNavigate();
  const { environment, scope } = useSettingsScope();
  const profileHomeDirectory = environment?.serverConfig?.profileHomeDirectory;
  const setProfile = (profile: ProjectProfile | undefined) => {
    void navigate({
      to: "/settings/providers",
      search: (current) => {
        const { profile: _previousProfile, ...rest } = current;
        return profile === undefined ? rest : { ...rest, profile };
      },
      replace: true,
      hash: "",
      hashScrollIntoView: false,
    });
  };
  const selectedProfile =
    target.profile === "work" || target.profile === "personal" ? target.profile : null;
  if (selectedProfile !== null) {
    return (
      <SettingsPageContainer>
        <SettingsSection
          title={`${selectedProfile === "work" ? "Work" : "Personal"} profile tools`}
          className="@container/settings"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 p-3">
            <p className="max-w-xl text-sm text-muted-foreground">
              These tool permissions apply to projects in this profile. Provider credentials and
              native MCP configuration are isolated by the selected profile.
            </p>
            <div className="flex shrink-0 gap-1">
              <Button
                size="xs"
                variant={selectedProfile === "work" ? "default" : "outline"}
                onClick={() => setProfile("work")}
              >
                Work
              </Button>
              <Button
                size="xs"
                variant={selectedProfile === "personal" ? "default" : "outline"}
                onClick={() => setProfile("personal")}
              >
                Personal
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setProfile(undefined)}>
                Environment providers
              </Button>
            </div>
          </div>
          <div className="p-3 pt-0">
            <div className="mb-3">
              <ProfileNativeProvidersSettings
                key={`${environment?.environmentId ?? "none"}-${selectedProfile}`}
                profile={selectedProfile}
                {...(environment ? { environmentId: environment.environmentId } : {})}
                {...(profileHomeDirectory ? { profileHomeDirectory } : {})}
              />
            </div>
            <ProfileToolAccessSettings profile={selectedProfile} />
          </div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  if (!environment) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Work and Personal profile tools">
          <ProfileSettingsEntry onSelect={setProfile} />
        </SettingsSection>
        <p className="p-4 text-sm text-muted-foreground">
          {scope.kind === "environment"
            ? `Reconnect ${scope.label} to set up its environment providers.`
            : "Connect an environment to set up environment providers."}
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="shrink-0 border-b px-3 py-2 sm:px-4">
        <div className="mb-1 text-sm font-semibold">Work and Personal profile tools</div>
        <ProfileSettingsEntry onSelect={setProfile} />
      </section>
      <ProviderSettingsPanel
        environmentId={environment.environmentId}
        {...(target.instanceId ? { instanceId: target.instanceId } : {})}
        projectIds={
          scope.kind === "project" || scope.kind === "checkout"
            ? scope.members
                .filter((member) => member.environmentId === environment.environmentId)
                .map((member) => member.id)
            : []
        }
        scoped
      />
    </div>
  );
}

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(raw.profile === "work" || raw.profile === "personal" ? { profile: raw.profile } : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
