import type { ProjectProfile } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

type MutableProfileToolAccessPatch = {
  enableAgentBrowserAccess?: boolean;
  enableAgentDeviceAccess?: boolean;
};

const TOOL_ACCESS_CONTROLS = [
  {
    key: "enableAgentBrowserAccess",
    title: "Shared browser",
    description: "Allow agents assigned to this profile to use the shared browser.",
  },
  {
    key: "enableAgentDeviceAccess",
    title: "Device control",
    description: "Allow agents assigned to this profile to control configured devices.",
  },
] as const satisfies ReadonlyArray<{
  readonly key: "enableAgentBrowserAccess" | "enableAgentDeviceAccess";
  readonly title: string;
  readonly description: string;
}>;

/** Compact profile policy controls for built-in agent tools. */
export function ProfileToolAccessSettings({ profile }: { readonly profile: ProjectProfile }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  const profileAccess = settings.profileToolAccess[profile] ?? {};

  const updateAccess = (
    key: (typeof TOOL_ACCESS_CONTROLS)[number]["key"],
    enabled: boolean | undefined,
  ) => {
    const next: MutableProfileToolAccessPatch = {
      ...(profileAccess.enableAgentBrowserAccess === undefined
        ? {}
        : { enableAgentBrowserAccess: profileAccess.enableAgentBrowserAccess }),
      ...(profileAccess.enableAgentDeviceAccess === undefined
        ? {}
        : { enableAgentDeviceAccess: profileAccess.enableAgentDeviceAccess }),
    };
    if (enabled === undefined) {
      if (key === "enableAgentBrowserAccess") delete next.enableAgentBrowserAccess;
      else delete next.enableAgentDeviceAccess;
    } else {
      next[key] = enabled;
    }
    updateSettings({
      profileToolAccess: {
        [profile]: next,
      },
    });
  };

  return (
    <fieldset disabled={!canWrite} className="min-w-0 space-y-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Built-in agent tools</legend>
      <p className="text-xs text-muted-foreground">
        Projects assigned to {profile === "work" ? "Work" : "Personal"} use these values unless a
        project has its own override. Unset values follow environment settings.
      </p>
      <div className="divide-y">
        {TOOL_ACCESS_CONTROLS.map(({ key, title, description }) => {
          const override = profileAccess[key];
          const fallback = settings[key] ?? DEFAULT_SERVER_SETTINGS[key];
          const checked = override ?? fallback;
          return (
            <div key={key} className="flex min-h-12 items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{title}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
                {override === undefined ? (
                  <div className="text-xs text-muted-foreground">
                    Inherits environment: {fallback ? "On" : "Off"}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {override !== undefined ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Inherit environment ${title.toLowerCase()} setting`}
                    onClick={() => updateAccess(key, undefined)}
                  >
                    Inherit
                  </Button>
                ) : null}
                <Switch
                  size="sm"
                  checked={checked}
                  aria-label={`${title} for ${profile} profile`}
                  onCheckedChange={(enabled) => updateAccess(key, enabled)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
