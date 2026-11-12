import {
  ProfileMcpServerToggleError,
  type EnvironmentId,
  type ProfileMcpInventoryResult,
  type ProjectProfile,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStableCallback } from "../../hooks/useStableCallback";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const isProfileMcpServerToggleError = Schema.is(ProfileMcpServerToggleError);

function joinHome(base: string, ...segments: string[]) {
  const separator = base.includes("\\") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...segments].join(separator);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function ProfileNativeProvidersSettings({
  profile,
  profileHomeDirectory,
  environmentId,
}: {
  readonly profile: ProjectProfile;
  readonly profileHomeDirectory?: string;
  readonly environmentId?: EnvironmentId;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providerSettings = settings.profileProviderSettings[profile];
  const readInventory = useAtomCommand(serverEnvironment.profileMcpInventory, {
    reportFailure: false,
  });
  const setMcpServerEnabled = useAtomCommand(serverEnvironment.profileSetMcpServerEnabled, {
    reportFailure: false,
  });
  const canManageProviders = useAtomValue(
    serverEnvironment.profileSetMcpServerEnabled.permissionAtom(environmentId ?? null),
  );
  const [authoritativeInventory, setAuthoritativeInventory] = useState<{
    readonly key: string;
    readonly value: ProfileMcpInventoryResult;
  } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{
    readonly key: string;
    readonly type: "read" | "write";
    readonly message?: string;
  } | null>(null);
  const [busyServerKey, setBusyServerKey] = useState<string | null>(null);
  const [mcpChangedKey, setMcpChangedKey] = useState<string | null>(null);
  const busyServerRef = useRef(false);
  const readRequestVersion = useRef(0);
  const scopeKey = `${environmentId ?? "none"}:${profile}`;
  const inventory = authoritativeInventory?.key === scopeKey ? authoritativeInventory.value : null;
  const inventoryLoading = loadingKey === scopeKey;
  const inventoryError = errorState?.key === scopeKey ? errorState.type : null;
  const currentBusyServerKey = busyServerKey?.startsWith(`${scopeKey}:`)
    ? busyServerKey.slice(scopeKey.length + 1)
    : null;
  const mcpChanged = mcpChangedKey === scopeKey;
  const codexHome = profileHomeDirectory ? joinHome(profileHomeDirectory, profile, "codex") : null;
  const claudeHome = profileHomeDirectory
    ? joinHome(profileHomeDirectory, profile, "claude")
    : null;

  const setEnabled = (key: "codexEnabled" | "claudeEnabled", enabled: boolean) => {
    if (!canManageProviders) return;
    const patch = { [key]: enabled };
    updateSettings({ profileProviderSettings: { [profile]: patch } });
  };

  const copySetup = (value: string, target: string) => {
    void writeTextToClipboard(value, target).then(
      () => toastManager.add({ type: "success", title: `${target} copied` }),
      () => toastManager.add({ type: "error", title: `Could not copy ${target}` }),
    );
  };

  const refreshInventory = useStableCallback(async (key: string) => {
    if (!environmentId || busyServerRef.current) return;
    const version = ++readRequestVersion.current;
    setLoadingKey(key);
    setErrorState(null);
    try {
      const result = await readInventory({ environmentId, input: { scope: profile } });
      if (readRequestVersion.current !== version) return;
      if (result._tag === "Success") setAuthoritativeInventory({ key, value: result.value });
      else if (!isAtomCommandInterrupted(result)) setErrorState({ key, type: "read" });
    } catch {
      if (readRequestVersion.current === version) setErrorState({ key, type: "read" });
    }
    if (readRequestVersion.current === version) setLoadingKey(null);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the server-owned inventory on open/profile change
  useEffect(() => {
    void refreshInventory(scopeKey);
    return () => {
      readRequestVersion.current += 1;
    };
  }, [scopeKey, refreshInventory]);

  const toggleMcpServer = async (provider: "codex" | "claude", name: string, enabled: boolean) => {
    if (!environmentId || busyServerRef.current || !canManageProviders) return;
    const key = `${scopeKey}:${provider}:${name}`;
    busyServerRef.current = true;
    readRequestVersion.current += 1;
    setLoadingKey(null);
    setBusyServerKey(key);
    setErrorState(null);
    try {
      const result = await setMcpServerEnabled({
        environmentId,
        input: { scope: profile, provider, name, enabled },
      });
      if (result._tag === "Success") {
        setAuthoritativeInventory({ key: scopeKey, value: result.value });
        setMcpChangedKey(scopeKey);
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setErrorState({
          key: scopeKey,
          type: "write",
          message: isProfileMcpServerToggleError(error)
            ? error.message
            : "Could not update this MCP server. Check permissions and try again.",
        });
      }
    } catch {
      setErrorState({
        key: scopeKey,
        type: "write",
        message: "Could not update this MCP server. Check permissions and try again.",
      });
    }
    busyServerRef.current = false;
    setBusyServerKey(null);
  };

  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label="Profile native providers">
      <div>
        <h3 className="text-sm font-medium">Codex and Claude configuration</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Each profile gets separate credentials and native MCP configuration. Sign in separately
          inside each home; T3 does not copy credentials between profiles.
        </p>
      </div>
      <div className="divide-y rounded-md border px-3">
        <ProviderRow
          name="Codex"
          description={
            codexHome ?? "Select a connected environment to show its isolated home path."
          }
          enabled={providerSettings.codexEnabled}
          disabled={!canManageProviders}
          onEnabledChange={(value) => setEnabled("codexEnabled", value)}
        />
        <ProviderRow
          name="Claude Code"
          description={
            claudeHome ?? "Select a connected environment to show its isolated home path."
          }
          enabled={providerSettings.claudeEnabled}
          disabled={!canManageProviders}
          onEnabledChange={(value) => setEnabled("claudeEnabled", value)}
        />
      </div>
      {!profileHomeDirectory ? (
        <p className="text-xs text-muted-foreground">
          Select or connect an environment to reveal its profile homes and native setup commands.
        </p>
      ) : null}
      {codexHome && claudeHome ? (
        <div className="space-y-3">
          <div className="space-y-2 rounded-md bg-muted/40 p-3">
            <h4 className="text-sm font-medium">Sign in to the native provider</h4>
            <p className="text-xs text-muted-foreground">
              These commands sign in only to the selected profile’s isolated home.
            </p>
            <div className="grid gap-2 @md/settings:grid-cols-2">
              <SetupCommand
                name="Codex sign in"
                command={`CODEX_HOME=${shellQuote(codexHome)} codex login`}
                onCopy={copySetup}
              />
              <SetupCommand
                name="Claude Code sign in"
                command={`CLAUDE_CONFIG_DIR=${shellQuote(claudeHome)} claude auth login`}
                onCopy={copySetup}
              />
            </div>
          </div>
          <div className="space-y-2 rounded-md bg-muted/40 p-3">
            <h4 className="text-sm font-medium">Add an MCP server</h4>
            <p className="text-xs text-muted-foreground">
              Use the matching profile home in the command. Replace placeholders with your MCP
              server name, transport details and URL.
            </p>
            <div className="grid gap-2 @md/settings:grid-cols-2">
              <SetupCommand
                name="Codex"
                command={`CODEX_HOME=${shellQuote(codexHome)} codex mcp add my-server --url https://example.org/mcp`}
                onCopy={copySetup}
                docsUrl="https://developers.openai.com/codex/mcp"
                docsLabel="Codex MCP docs"
              />
              <SetupCommand
                name="Claude Code"
                command={`CLAUDE_CONFIG_DIR=${shellQuote(claudeHome)} claude mcp add --transport http --scope user my-server https://example.org/mcp`}
                onCopy={copySetup}
                docsUrl="https://code.claude.com/docs/en/mcp"
                docsLabel="Claude Code MCP docs"
              />
            </div>
          </div>
        </div>
      ) : null}
      <section className="space-y-2 rounded-md border p-3" aria-label="Configured MCP servers">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-medium">Configured MCP servers</h4>
            <p className="text-xs text-muted-foreground">
              Names and enabled state from this profile’s Codex and Claude configuration.
            </p>
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={!environmentId || inventoryLoading || currentBusyServerKey !== null}
            onClick={() => void refreshInventory(scopeKey)}
          >
            {inventoryLoading ? (inventory === null ? "Loading…" : "Refreshing…") : "Refresh"}
          </Button>
        </div>
        {!environmentId ? (
          <p className="text-xs text-muted-foreground">
            Select a connected environment to inspect its profile.
          </p>
        ) : inventoryError === "read" ? (
          <p role="alert" className="text-xs text-destructive">
            Could not read MCP configuration. Try refreshing.
          </p>
        ) : inventory === null ? (
          <p className="text-xs text-muted-foreground">Refresh to inspect configured servers.</p>
        ) : (
          <>
            {inventoryError === "write" ? (
              <p role="alert" className="text-xs text-destructive">
                {errorState?.message ?? "Could not update this MCP server. Try again."}
              </p>
            ) : null}
            {mcpChanged ? (
              <p className="text-xs text-muted-foreground">
                Restart T3 Code, or the T3 server for remote environments, to apply changes to
                active provider sessions.
              </p>
            ) : null}
            <div className="grid gap-2 @md/settings:grid-cols-2">
              <InventoryProvider
                name="Codex"
                providerId="codex"
                provider={inventory.codex}
                canManage={canManageProviders}
                busyServerKey={currentBusyServerKey}
                onEnabledChange={toggleMcpServer}
              />
              <InventoryProvider
                name="Claude Code"
                providerId="claude"
                provider={inventory.claude}
                canManage={canManageProviders}
                busyServerKey={currentBusyServerKey}
                onEnabledChange={toggleMcpServer}
              />
            </div>
          </>
        )}
      </section>
    </section>
  );
}

function InventoryProvider({
  name,
  providerId,
  provider,
  canManage,
  busyServerKey,
  onEnabledChange,
}: {
  readonly name: string;
  readonly providerId: "codex" | "claude";
  readonly provider: ProfileMcpInventoryResult["codex"];
  readonly canManage: boolean;
  readonly busyServerKey: string | null;
  readonly onEnabledChange: (provider: "codex" | "claude", name: string, enabled: boolean) => void;
}) {
  const statusLabel = {
    missing: "Configuration file missing",
    empty: "No MCP servers configured",
    configured: "Configured servers",
    parse_error: "Configuration could not be read",
  }[provider.status];
  return (
    <div className="min-w-0 rounded-md border p-2">
      <div className="text-xs font-medium">{name}</div>
      {provider.servers.length ? (
        <ul className="mt-1 space-y-1 text-xs">
          {provider.servers.map((server) => (
            <li key={server.name} className="flex items-center justify-between gap-2">
              <span className="truncate">{server.name}</span>
              {canManage ? (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-muted-foreground">
                    {busyServerKey === `${providerId}:${server.name}`
                      ? "Saving…"
                      : server.enabled
                        ? "Enabled"
                        : "Disabled"}
                  </span>
                  <Switch
                    size="sm"
                    checked={server.enabled}
                    disabled={busyServerKey !== null}
                    aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name} in ${name}`}
                    onCheckedChange={(enabled) => onEnabledChange(providerId, server.name, enabled)}
                  />
                </div>
              ) : (
                <span className="shrink-0 text-muted-foreground">
                  {server.enabled ? "Enabled" : "Disabled"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{statusLabel}</p>
      )}
    </div>
  );
}

function ProviderRow({
  name,
  description,
  enabled,
  disabled,
  onEnabledChange,
}: {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly disabled?: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{name}</div>
        <code className="block break-all text-xs text-muted-foreground">{description}</code>
      </div>
      <Switch
        size="sm"
        checked={enabled}
        disabled={disabled}
        aria-label={`${name} for profile`}
        onCheckedChange={onEnabledChange}
      />
    </div>
  );
}

function SetupCommand({
  name,
  command,
  onCopy,
  docsUrl,
  docsLabel,
}: {
  readonly name: string;
  readonly command: string;
  readonly onCopy: (command: string, target: string) => void;
  readonly docsUrl?: string;
  readonly docsLabel?: string;
}) {
  return (
    <div className="min-w-0 space-y-2 rounded-md border bg-background p-2">
      <div className="text-xs font-medium">{name}</div>
      <code className="block break-all text-2xs text-muted-foreground">{command}</code>
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" onClick={() => onCopy(command, `${name} MCP command`)}>
          Copy command
        </Button>
        {docsUrl && docsLabel ? (
          <a
            className="text-xs text-primary underline-offset-4 hover:underline"
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
          >
            {docsLabel}
          </a>
        ) : null}
      </div>
    </div>
  );
}
