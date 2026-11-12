import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  resolveProjectProfile,
  type EnvironmentId,
  type ProjectProfileToolAccess,
  type ProjectProfileToolKind,
  type ProjectProfileToolProvider,
  type ProjectToolsInventoryResult,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useStableCallback } from "../../hooks/useStableCallback";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";

type Inventory = ProjectToolsInventoryResult;
type ProjectTarget = {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly environmentLabel: string | null;
};
type DisplayToolRow = Inventory["mcpServers"][number] & { readonly orphan?: boolean };

const PROVIDERS: ReadonlyArray<{ value: ProjectProfileToolProvider; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
];
const EMPTY_SETTINGS_ATOM = Atom.make(DEFAULT_SERVER_SETTINGS);

/** Project-only exclusions for native MCP servers and skills. */
export function ProjectToolAccessSettings({
  projects,
}: {
  readonly projects: ReadonlyArray<ProjectTarget>;
}) {
  const [selectedKey, setSelectedKey] = useState(
    projects.length === 1 ? targetKey(projects[0]!) : "",
  );
  const activeKey = projects.length === 1 ? targetKey(projects[0]!) : selectedKey;
  const target = projects.find((project) => targetKey(project) === activeKey) ?? null;
  const environmentId = target?.environmentId ?? null;
  const projectId = target?.id ?? null;
  const settingsSnapshot = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : EMPTY_SETTINGS_ATOM,
  );
  const settingsReady = settingsSnapshot !== null && settingsSnapshot !== undefined;
  const settings = settingsSnapshot ?? DEFAULT_SERVER_SETTINGS;
  const profile = resolveProjectProfile(settings, projectId);
  const access: ProjectProfileToolAccess | undefined = projectId
    ? settings.projectSettingsOverrides[projectId]?.profileToolAccess?.[profile]
    : undefined;
  const inventoryCommand = useAtomCommand(serverEnvironment.projectToolsInventory, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canManage = settingsReady && canManageProviders && canWriteSettings;
  const [provider, setProvider] = useState<ProjectProfileToolProvider>("codex");
  const [kind, setKind] = useState<ProjectProfileToolKind>("mcpServers");
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; value: Inventory } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const scopeKey = target
    ? `${targetKey(target)}:${settingsReady ? profile : "settings-loading"}`
    : "none";
  const inventory = loaded?.key === scopeKey ? loaded.value : null;

  const refresh = useStableCallback(async (key: string) => {
    if (!target || !environmentId || !projectId || !settingsReady) {
      setLoadingKey(null);
      return;
    }
    const version = ++requestRef.current;
    setLoadingKey(key);
    setErrorKey(null);
    try {
      const result = await inventoryCommand({ environmentId, input: { projectId } });
      if (version !== requestRef.current) return;
      if (result._tag === "Success") {
        if (result.value.projectId === projectId && result.value.profile === profile) {
          setLoaded({ key, value: result.value });
        } else {
          setLoaded(null);
          setErrorKey(key);
        }
      } else setErrorKey(key);
    } catch {
      if (version === requestRef.current) setErrorKey(key);
    }
    if (version === requestRef.current) setLoadingKey(null);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load server-owned inventory when the selected checkout/profile changes
  useEffect(() => {
    void refresh(scopeKey);
    return () => {
      requestRef.current += 1;
    };
  }, [scopeKey, refresh]);

  const toggle = async (name: string, enabled: boolean) => {
    if (
      !target ||
      !environmentId ||
      !projectId ||
      !settingsReady ||
      busyRef.current ||
      !canManage ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
      !readEnvironmentScope(environmentId, AuthSettingsWriteScope)
    )
      return;
    busyRef.current = true;
    setBusyName(name);
    const denial = enabled ? null : true;
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            projectProfileToolAccessOverrides: {
              [projectId]: {
                [profile]: { [kind]: { [provider]: { [name]: denial } } },
              },
            },
          },
        },
      });
      if (result._tag !== "Success") setErrorKey(scopeKey);
      else setErrorKey(null);
    } catch {
      setErrorKey(scopeKey);
    }
    setBusyName(null);
    busyRef.current = false;
  };

  const denied = access?.[kind]?.[provider] ?? {};
  const rows = (kind === "mcpServers" ? inventory?.mcpServers : inventory?.skills) ?? [];
  const providerRows = rows.filter((row) => row.provider === provider);
  const visibleRows: ReadonlyArray<DisplayToolRow> = [
    ...providerRows,
    ...Object.keys(denied)
      .filter((name) => denied[name] === true && !providerRows.some((row) => row.name === name))
      .map((name) => ({
        name,
        provider,
        source: "project" as const,
        enabled: false,
        orphan: true,
      })),
  ];
  const filtered = visibleRows.filter((row) =>
    row.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const inventoryUnavailable =
    inventory !== null &&
    ((kind === "mcpServers" && inventory.providerStatus[provider] === "parse_error") ||
      (kind === "skills" && inventory.skillsStatus[provider] === "unavailable"));

  const resetAll = async () => {
    if (
      !target ||
      !environmentId ||
      !projectId ||
      !settingsReady ||
      busyRef.current ||
      !canManage ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
      !readEnvironmentScope(environmentId, AuthSettingsWriteScope)
    )
      return;
    const names = Object.keys(denied).filter((name) => denied[name] === true);
    if (!names.length) return;
    busyRef.current = true;
    setBusyName("*");
    try {
      const remove = Object.fromEntries(names.map((name) => [name, null]));
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            projectProfileToolAccessOverrides: {
              [projectId]: {
                [profile]: { [kind]: { [provider]: remove } },
              },
            },
          },
        },
      });
      if (result._tag !== "Success") setErrorKey(scopeKey);
      else setErrorKey(null);
    } catch {
      setErrorKey(scopeKey);
    }
    setBusyName(null);
    busyRef.current = false;
  };

  return (
    <SettingsSection title="Tools">
      {projects.length > 1 ? (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Checkout</span>
          <Select
            value={selectedKey}
            onValueChange={(value) => {
              if (value !== null) setSelectedKey(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Tools checkout">
              <SelectValue placeholder="Choose a checkout" />
            </SelectTrigger>
            <SelectPopup>
              {projects.map((project) => (
                <SelectItem key={targetKey(project)} value={targetKey(project)}>
                  {project.environmentLabel ?? project.environmentId} · {project.workspaceRoot}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      {!target ? (
        <p className="py-2 text-xs text-muted-foreground">
          Choose a checkout to manage its inherited tools.
        </p>
      ) : !settingsReady ? (
        <p className="py-2 text-xs text-muted-foreground">Loading project settings…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={provider}
              onValueChange={(value) => {
                if (value === "codex" || value === "claude") setProvider(value);
              }}
            >
              <SelectTrigger size="sm" aria-label="Tool provider">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {PROVIDERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Select
              value={kind}
              onValueChange={(value) => {
                if (value === "mcpServers" || value === "skills") setKind(value);
              }}
            >
              <SelectTrigger size="sm" aria-label="Tool type">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="mcpServers">MCP servers</SelectItem>
                <SelectItem value="skills">Skills</SelectItem>
              </SelectPopup>
            </Select>
            <Input
              className="h-8 min-w-36 flex-1"
              aria-label="Filter tools"
              placeholder="Filter…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={loadingKey === scopeKey || busyName !== null}
              onClick={() => void refresh(scopeKey)}
            >
              Refresh
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canManage || busyName !== null || !Object.values(denied).some(Boolean)}
              onClick={() => void resetAll()}
            >
              Reset this list
            </Button>
          </div>
          {loadingKey === scopeKey && !inventory ? (
            <p className="py-3 text-xs text-muted-foreground">Loading…</p>
          ) : null}
          {errorKey === scopeKey ? (
            <div className="flex items-center gap-2 py-2 text-xs text-destructive">
              <span>Could not load or save project tools. Check access and try again.</span>
              <Button size="xs" variant="outline" onClick={() => void refresh(scopeKey)}>
                Retry
              </Button>
            </div>
          ) : null}
          {inventory || Object.values(denied).some(Boolean) ? (
            <div className="mt-2 max-h-72 divide-y overflow-y-auto rounded-md border px-3">
              {inventoryUnavailable ? (
                <p className="py-2 text-xs text-muted-foreground">
                  This tool list is unavailable for the selected provider.
                </p>
              ) : null}
              {kind === "mcpServers" && inventory?.providerStatus[provider] === "missing" ? (
                <p className="py-2 text-xs text-muted-foreground">
                  No MCP servers are configured for this provider.
                </p>
              ) : null}
              {inventory?.providerEnabled[provider] === false ? (
                <p className="py-2 text-xs text-muted-foreground">
                  {PROVIDERS.find((item) => item.value === provider)?.label} is disabled in the{" "}
                  {profile === "work" ? "Work" : "Personal"} profile.
                </p>
              ) : null}
              {filtered.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                  No matching {kind === "skills" ? "skills" : "MCP servers"}.
                </p>
              ) : (
                filtered.map((row) => {
                  const isDenied = denied[row.name] === true;
                  const enabled = row.enabled && !isDenied;
                  const canToggle =
                    canManage &&
                    !row.orphan &&
                    inventory?.providerEnabled[provider] !== false &&
                    row.enabled;
                  const stateLabel = row.orphan
                    ? inventory
                      ? "No longer configured · project override"
                      : "Project override · list not loaded"
                    : isDenied
                      ? "Disabled for this project"
                      : inventory?.providerEnabled[provider] === false
                        ? `Disabled in ${profile === "work" ? "Work" : "Personal"}`
                        : row.source === "project" && !row.enabled
                          ? "Disabled in project configuration"
                          : !row.enabled
                            ? `Disabled in ${profile === "work" ? "Work" : "Personal"}`
                            : row.source === "project"
                              ? row.enabled
                                ? "From project configuration"
                                : "Disabled in project configuration"
                              : "Inherits profile setting";
                  return (
                    <div
                      key={`${row.provider}:${row.name}`}
                      className="flex min-h-10 items-center justify-between gap-3 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm">{row.name}</div>
                        <div className="text-2xs text-muted-foreground">{stateLabel}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {isDenied ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={!canManage || busyName !== null}
                            onClick={() => void toggle(row.name, true)}
                          >
                            Inherit
                          </Button>
                        ) : null}
                        <Switch
                          size="sm"
                          checked={enabled}
                          disabled={!canToggle || busyName !== null}
                          aria-label={`${row.name} enabled`}
                          onCheckedChange={(checked) => void toggle(row.name, checked)}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
          <p className="mt-2 text-2xs text-muted-foreground">
            Project settings can disable inherited tools. Profile-disabled tools stay off.
          </p>
        </>
      )}
    </SettingsSection>
  );
}

function targetKey(target: ProjectTarget): string {
  return `${target.environmentId}:${target.id}`;
}
