import { describe, expect, it } from "vitest";
import { createEmptyState } from "../packages/core/index.js";
import type {
  BrokerState,
  DeliveryRecord,
  ObservationRecord,
  ResolvedProjectConfig,
  RouteRecord,
} from "../packages/core/index.js";
import {
  createStatusReport,
  formatStatus,
  parseStatusArgs,
  type StatusContext,
} from "../packages/cli/status.js";

const project: ResolvedProjectConfig = {
  path: "/Users/cameron/letta/claude-subconscious/subconscious.toml",
  projectRoot: "/Users/cameron/letta/claude-subconscious",
  config: {
    version: 1,
    agentId: "agent-184c033f-cca7-40e3-817e-5e6fc02d9c0c",
    model: "letta/auto",
    delivery: { whispers: true, queueMessages: false },
    observer: {},
  },
};

function route(key: string, sessionId: string, updatedAt: string): RouteRecord {
  return {
    key,
    configPath: project.path,
    projectRoot: project.projectRoot,
    agentId: project.config.agentId!,
    model: project.config.model,
    harness: "claude-code",
    sessionId,
    conversationId: null,
    clientDeliveryTools: ["send_whisper"],
    runtimeReportedTools: ["Read"],
    attachedServerTools: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function observation(
  id: string,
  routeKey: string,
  status: ObservationRecord["status"],
  updatedAt: string,
): ObservationRecord {
  return {
    event: {
      id,
      harness: "claude-code",
      type: "session_start",
      sessionId: routeKey,
      workingDirectory: project.projectRoot,
      occurredAt: updatedAt,
      payload: {},
    },
    routeKey,
    config: project.config,
    status,
    attempts: 1,
    createdAt: updatedAt,
    updatedAt,
    otid: id,
  };
}

function whisper(
  id: string,
  expiresAt: string,
  routeKey = "first",
): DeliveryRecord {
  return {
    id,
    routeKey,
    observationId: "observation",
    kind: "whisper",
    text: "Guidance",
    priority: "normal",
    dedupeKey: id,
    status: "pending",
    createdAt: "2026-08-17T20:00:00.000Z",
    expiresAt,
    attempts: 0,
  };
}

function context(state: BrokerState): StatusContext {
  return {
    broker: { online: true, pid: 20267 },
    requestedPath: project.projectRoot,
    project,
    state,
  };
}

describe("status command", () => {
  it("parses a path and explicit output modes in either order", () => {
    expect(parseStatusArgs(["--detail", "/project"], "/fallback")).toEqual({
      path: "/project",
      json: false,
      detail: true,
    });
    expect(parseStatusArgs(["/project", "--json"], "/fallback")).toEqual({
      path: "/project",
      json: true,
      detail: false,
    });
    expect(() => parseStatusArgs(["--json", "--detail"])).toThrow(
      "Use either --json or --detail",
    );
  });

  it("shows the active project and live work without route dumps", () => {
    const state = createEmptyState();
    state.routes.first = route(
      "first",
      "dc4f8fb1-2795-4c1e-bb7a-9ba94ce2002f",
      "2026-08-17T21:00:00.000Z",
    );
    state.routes.second = route(
      "second",
      "0bc79a12-2b25-4e56-ab0a-88ed9027403b",
      "2026-08-17T21:01:00.000Z",
    );
    state.observations.processing = observation(
      "processing",
      "first",
      "processing",
      "2026-08-17T21:00:00.000Z",
    );
    state.observations.queued = observation(
      "queued",
      "second",
      "queued",
      "2026-08-17T21:01:00.000Z",
    );

    expect(formatStatus(context(state), { homeDirectory: "/Users/cameron" }))
      .toBe(`Subconscious status

Broker      online (PID 20267)
Project     ~/letta/claude-subconscious
Observer    agent-184c033f-cca... (letta/auto)
Work        1 processing, 1 queued
Whispers    none waiting
Failures    none`);
  });

  it("makes reconciliation failures actionable", () => {
    const state = createEmptyState();
    state.routes.blocked = route(
      "blocked",
      "session-blocked",
      "2026-08-17T21:00:00.000Z",
    );
    const eventId = "claude-code:session-blocked:turn-12";
    state.observations[eventId] = observation(
      eventId,
      "blocked",
      "needs_reconciliation",
      "2026-08-17T21:00:00.000Z",
    );

    const output = formatStatus(context(state));

    expect(output).toContain("Failures    1 need reconciliation");
    expect(output).toContain(
      `Action      subconscious reconcile ${eventId} --retry`,
    );
  });

  it("counts only unexpired whispers and reports disabled delivery", () => {
    const state = createEmptyState();
    state.routes.first = route("first", "session", "2026-08-17T21:00:00.000Z");
    state.deliveries.live = whisper("live", "2026-08-17T22:00:00.000Z");
    state.deliveries.expired = whisper("expired", "2026-08-17T20:30:00.000Z");
    const disabledProject = structuredClone(project);
    disabledProject.config.delivery.whispers = false;

    const output = formatStatus(
      { ...context(state), project: disabledProject },
      { now: "2026-08-17T21:30:00.000Z" },
    );

    expect(output).toContain("Whispers    1 waiting (delivery disabled)");
  });

  it("adds recent route history only in detail mode", () => {
    const state = createEmptyState();
    state.routes.first = route(
      "first",
      "dc4f8fb1-2795-4c1e-bb7a-9ba94ce2002f",
      "2026-08-17T21:00:00.000Z",
    );
    state.observations.done = observation(
      "done",
      "first",
      "processed",
      "2026-08-17T21:00:01.000Z",
    );

    const output = formatStatus(context(state), { detail: true });

    expect(output).toContain("History");
    expect(output).toContain("Observed    1 processed");
    expect(output).toContain("Recent routes");
    expect(output).toContain("claude-code  ready");
    expect(output).toContain(project.config.agentId!);
    expect(output).not.toContain("clientToolAllowlist");
    expect(output).not.toContain("runtimeReportedTools");
  });

  it("explains an offline, unconfigured project", () => {
    const output = formatStatus(
      {
        broker: { online: false },
        requestedPath: "/Users/cameron/unconfigured",
        project: null,
        state: createEmptyState(),
      },
      { homeDirectory: "/Users/cameron" },
    );

    expect(output).toContain("Broker      offline");
    expect(output).toContain("Project     not configured for ~/unconfigured");
    expect(output).toContain("Work        no configured project");
    expect(output).toContain("Start       subconscious start");
  });

  it("keeps the complete status report for JSON consumers", () => {
    const state = createEmptyState();
    state.routes.first = route(
      "first",
      "session-full-id",
      "2026-08-17T21:00:00.000Z",
    );
    const report = createStatusReport(context(state));

    expect(report.state.routes[0]).toMatchObject({
      sessionId: "session-full-id",
      conversationId: null,
      clientToolAllowlist: [
        "Read",
        "LS",
        "Glob",
        "Grep",
        "memory_apply_patch",
        "send_whisper",
      ],
      runtimeReportedTools: ["Read"],
      attachedServerTools: [],
    });
  });

  it("reports override provenance and effective models for JSON consumers", () => {
    const state = createEmptyState();
    state.routes.first = {
      ...route("first", "session-json", "2026-08-17T21:00:00.000Z"),
      requestedModel: "anthropic/claude-sonnet-5",
      modelOverrideSource: "harness",
      reasoningEffort: "high",
      effectiveModel: "anthropic/claude-sonnet-5",
    };
    state.routes.second = route(
      "second",
      "session-legacy",
      "2026-08-17T21:01:00.000Z",
    );
    const report = createStatusReport(context(state));

    expect(report.project?.config.model).toBe("letta/auto");
    expect(report.project?.config.modelOverrides).toBeNull();
    expect(report.state.routes[0]).toMatchObject({
      requestedModel: "anthropic/claude-sonnet-5",
      modelOverrideSource: "harness",
      reasoningEffort: "high",
      effectiveModel: "anthropic/claude-sonnet-5",
    });
    // A legacy route with only the old field still reports something honest.
    expect(report.state.routes[1]).toMatchObject({
      requestedModel: "letta/auto",
      modelOverrideSource: null,
      effectiveModel: null,
    });
  });

  it("says agent default when no model level applies", () => {
    const unmodeled = {
      ...project,
      config: { ...project.config, model: undefined },
    };
    const output = formatStatus(
      {
        broker: { online: true, pid: 20267 },
        requestedPath: project.projectRoot,
        project: unmodeled,
        state: createEmptyState(),
      },
      { homeDirectory: "/Users/cameron" },
    );
    expect(output).toContain(
      "Observer    agent-184c033f-cca... (agent default)",
    );
  });

  it("shows requested, effective, source, and effort for each detail route", () => {
    const state = createEmptyState();
    state.routes.first = {
      ...route("first", "session-detail", "2026-08-17T21:00:00.000Z"),
      modelOverrideSource: "harness",
      reasoningEffort: "high",
      effectiveModel: "anthropic/claude-sonnet-5",
    };
    delete state.routes.first.model;
    state.routes.first.requestedModel = "anthropic/claude-sonnet-5";
    state.routes.second = {
      ...route("second", "session-detail-two", "2026-08-17T21:01:00.000Z"),
    };
    delete state.routes.second.model;
    const output = formatStatus(context(state), { detail: true });
    expect(output).toContain(
      "model anthropic/claude-sonnet-5 -> anthropic/claude-sonnet-5 [harness] (high)",
    );
    // A route with no decision anywhere states its inheritance plainly, with
    // no stale brackets or arrows on its own line.
    expect(output).toContain("model inherit");
    expect(output).not.toContain("[project]");
    const inheritLine = output
      .split("\n")
      .filter((line) => line.includes("model inherit"));
    expect(inheritLine).toHaveLength(1);
    expect(inheritLine[0]).not.toMatch(/->|\[|\]/);
  });

  it("keeps the non-detail output free of per-route model detail", () => {
    const state = createEmptyState();
    state.routes.first = {
      ...route("first", "session-compact", "2026-08-17T21:00:00.000Z"),
      requestedModel: "anthropic/claude-sonnet-5",
      modelOverrideSource: "harness",
      reasoningEffort: "high",
      effectiveModel: "anthropic/claude-sonnet-5",
    };
    const output = formatStatus(context(state));
    expect(output).toContain("(letta/auto)");
    expect(output).not.toContain("[harness]");
    expect(output).not.toContain("(high)");
    expect(output).not.toContain("-> anthropic");
  });
});
