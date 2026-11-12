import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import { buildCodexThreadPolicyConfig } from "./codexProjectPolicy.ts";

describe("buildCodexThreadPolicyConfig", () => {
  it("preserves every native disabled skill and adds denied project skills", () => {
    const baseConfig = {
      mcp_servers: {
        "t3-code": { command: "node", args: ["server.js"] },
        "t3-code-direct": { command: "node", args: ["direct.js"] },
      },
      model: "fixture-model",
    };

    const result = buildCodexThreadPolicyConfig({
      baseConfig,
      nativeSkills: [
        { path: "/profile/disabled/SKILL.md", enabled: false },
        { path: "/profile/enabled/SKILL.md", enabled: true },
      ],
      deniedSkillPaths: ["/project/denied/SKILL.md", "/profile/disabled/SKILL.md"],
    });

    NodeAssert.deepEqual(result.mcp_servers, baseConfig.mcp_servers);
    NodeAssert.equal(result.model, "fixture-model");
    NodeAssert.deepEqual(result.skills, {
      config: [
        { path: "/profile/disabled/SKILL.md", enabled: false },
        { path: "/project/denied/SKILL.md", enabled: false },
      ],
    });
  });

  it("retains existing thread config and does not re-enable a disabled skill", () => {
    const result = buildCodexThreadPolicyConfig({
      baseConfig: {
        mcp_servers: { "t3-code": { enabled: true } },
        skills: {
          experimental: true,
          config: [{ path: "/profile/disabled/SKILL.md", enabled: true, name: "disabled" }],
        },
      },
      nativeSkills: [{ path: "/profile/disabled/SKILL.md", enabled: false }],
      deniedSkillPaths: [],
    });

    NodeAssert.deepEqual(result.mcp_servers, { "t3-code": { enabled: true } });
    NodeAssert.deepEqual(result.skills, {
      experimental: true,
      config: [{ path: "/profile/disabled/SKILL.md", enabled: false, name: "disabled" }],
    });
  });

  it("is idempotent and accepts empty native skill inventory", () => {
    const first = buildCodexThreadPolicyConfig({
      nativeSkills: [],
      deniedSkillPaths: ["/project/denied/SKILL.md"],
    });
    const second = buildCodexThreadPolicyConfig({
      baseConfig: first,
      nativeSkills: [],
      deniedSkillPaths: ["/project/denied/SKILL.md"],
    });

    NodeAssert.deepEqual(second, first);
  });
});
