import { createMemoryHistory } from "@tanstack/react-router";
import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const REVIEW_URL = "https://arcanum.example/review/42";

it("shows Arc actions and the dirty branch's Arcanum review in thread details", async () => {
  const status = {
    vcsKind: "arc",
    isRepo: true,
    sourceControlProvider: {
      kind: SourceControlProviderKind.make("arcanum"),
      name: "Arcanum",
      baseUrl: "https://arcanum.example",
    },
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "users/test/feature",
    hasWorkingTreeChanges: true,
    workingTree: {
      rootPath: "/workspace/render",
      files: [{ path: "src/change.ts", insertions: 1, deletions: 0 }],
      insertions: 1,
      deletions: 0,
    },
    hasUpstream: true,
    trackingCountsKnown: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: {
      number: 42,
      title: "Arc chat toolbar",
      url: REVIEW_URL,
      baseRef: "trunk",
      headRef: "users/test/feature",
      state: "open",
    },
  } satisfies VcsStatusResult;
  const thread = threadWithHistory("arc-review", 1, "users/test/feature");
  using _environment = installFakeEnvironment([thread], { vcsStatus: status });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("Answer 0 for arc-review.")).toBeVisible();

  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  await page.getByRole("button", { name: "Toggle thread details panel" }).click();
  await act(() => {
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", true);
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", true);
  });
  await expect.element(page.getByRole("group", { name: "Arc actions" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: REVIEW_URL })).toBeVisible();
  await expect.element(page.getByRole("combobox")).toBeDisabled();
  await expect.element(page.getByText("+0", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Arc action options" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Push" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Commit" }).click();
  await expect.element(page.getByRole("dialog", { name: "Commit changes" })).toBeVisible();
  await expect.element(page.getByText("Commit on new branch")).not.toBeInTheDocument();
});
