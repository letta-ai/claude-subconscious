import { homedir } from "node:os";
import type {
  BrokerState,
  DeliveryRecord,
  ObservationRecord,
  ResolvedProjectConfig,
  RouteRecord,
} from "../core/index.js";

export interface StatusCommandOptions {
  path: string;
  json: boolean;
  detail: boolean;
}

export interface StatusContext {
  broker: { online: boolean; pid?: number };
  requestedPath: string;
  project: ResolvedProjectConfig | null;
  state: BrokerState;
}

export interface FormatStatusOptions {
  detail?: boolean;
  homeDirectory?: string;
  now?: string;
}

export function parseStatusArgs(
  args: string[],
  cwd = process.cwd(),
): StatusCommandOptions {
  let path: string | undefined;
  let json = false;
  let detail = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--detail") {
      detail = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown status option: ${arg}`);
    if (path) throw new Error("status accepts one project path.");
    path = arg;
  }
  if (json && detail) {
    throw new Error("Use either --json or --detail, not both.");
  }
  return { path: path ?? cwd, json, detail };
}

function countByStatus<T extends { status: string }>(
  records: T[],
): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
}

export function createStatusReport(context: StatusContext) {
  const projectSummary = context.project
    ? {
        path: context.project.path,
        projectRoot: context.project.projectRoot,
        config: {
          version: context.project.config.version,
          agentId: context.project.config.agentId,
          model: context.project.config.model,
          delivery: context.project.config.delivery,
          observerInstructionsConfigured: Boolean(
            context.project.config.observer.instructions?.trim(),
          ),
        },
      }
    : null;
  const routes = Object.values(context.state.routes);
  const observations = Object.values(context.state.observations);
  const deliveries = Object.values(context.state.deliveries);
  return {
    broker: context.broker.online
      ? { online: true, pid: context.broker.pid }
      : { online: false },
    project: projectSummary,
    state: {
      routeCount: routes.length,
      observationCounts: countByStatus(observations),
      deliveryCounts: countByStatus(deliveries),
      routes: routes.map((route) => ({
        harness: route.harness,
        projectRoot: route.projectRoot,
        agentId: route.agentId,
        sessionId: route.sessionId,
        conversationId: route.conversationId,
        clientToolAllowlist: [
          "Read",
          "LS",
          "Glob",
          "Grep",
          "memory_apply_patch",
          ...(route.clientDeliveryTools ?? []),
        ],
        runtimeReportedTools: route.runtimeReportedTools ?? null,
        attachedServerTools: route.attachedServerTools ?? null,
      })),
      failures: observations
        .filter(
          (observation) =>
            observation.status === "failed" ||
            observation.status === "needs_reconciliation",
        )
        .map((observation) => ({
          eventId: observation.event.id,
          status: observation.status,
          occurredAt: observation.event.occurredAt,
        })),
    },
  };
}

function projectRecords(context: StatusContext): {
  routes: RouteRecord[];
  observations: ObservationRecord[];
  deliveries: DeliveryRecord[];
} {
  if (!context.project) return { routes: [], observations: [], deliveries: [] };
  const routes = Object.values(context.state.routes).filter(
    (route) =>
      route.configPath === context.project?.path &&
      route.projectRoot === context.project.projectRoot &&
      route.agentId === context.project.config.agentId,
  );
  const routeKeys = new Set(routes.map((route) => route.key));
  return {
    routes,
    observations: Object.values(context.state.observations).filter(
      (observation) => routeKeys.has(observation.routeKey),
    ),
    deliveries: Object.values(context.state.deliveries).filter((delivery) =>
      routeKeys.has(delivery.routeKey),
    ),
  };
}

function compactPath(value: string, homeDirectory: string): string {
  const separator = value.includes("\\") ? "\\" : "/";
  const home = homeDirectory.replace(/[\\/]$/, "");
  const comparisonValue = separator === "\\" ? value.toLowerCase() : value;
  const comparisonHome = separator === "\\" ? home.toLowerCase() : home;
  if (comparisonValue === comparisonHome) return "~";
  const prefix = `${comparisonHome}${separator}`;
  return comparisonValue.startsWith(prefix)
    ? `~${separator}${value.slice(home.length + 1)}`
    : value;
}

function statusList(
  counts: Record<string, number>,
  order: string[],
  labels: Partial<Record<string, string>> = {},
): string {
  const parts = order.flatMap((status) => {
    const count = counts[status] ?? 0;
    return count > 0 ? [`${count} ${labels[status] ?? status}`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : "none";
}

function line(label: string, value: string): string {
  return `${label.padEnd(12)}${value}`;
}

function shortId(value: string, length = 16): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function routeStatus(
  route: RouteRecord,
  observations: ObservationRecord[],
): string {
  const latest = observations
    .filter((observation) => observation.routeKey === route.key)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!latest) return "idle";
  if (latest.status === "needs_reconciliation") return "blocked";
  if (latest.status === "processed") return "ready";
  return latest.status;
}

function formatFailures(observations: ObservationRecord[]): string[] {
  const failures = observations
    .filter(
      (observation) =>
        observation.status === "failed" ||
        observation.status === "needs_reconciliation",
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (failures.length === 0) return [line("Failures", "none")];
  const counts = countByStatus(failures);
  const lines = [
    line(
      "Failures",
      statusList(counts, ["needs_reconciliation", "failed"], {
        needs_reconciliation: "need reconciliation",
      }),
    ),
  ];
  const reconciliation = failures.find(
    (observation) => observation.status === "needs_reconciliation",
  );
  if (reconciliation) {
    lines.push(
      line(
        "Action",
        `subconscious reconcile ${reconciliation.event.id} --retry`,
      ),
    );
  } else {
    lines.push(line("Inspect", "subconscious status --detail"));
  }
  if (failures.length > 1) {
    lines.push(line("More", "subconscious status --detail"));
  }
  return lines;
}

function formatDetail(
  routes: RouteRecord[],
  observations: ObservationRecord[],
  deliveries: DeliveryRecord[],
): string[] {
  const observationCounts = countByStatus(observations);
  const deliveryCounts = countByStatus(deliveries);
  const lines = [
    "",
    "History",
    line(
      "Observed",
      statusList(observationCounts, [
        "processing",
        "queued",
        "needs_reconciliation",
        "failed",
        "processed",
        "discarded",
      ]),
    ),
    line(
      "Deliveries",
      statusList(deliveryCounts, ["pending", "stale", "expired", "delivered"]),
    ),
    line("Routes", `${routes.length}`),
  ];
  if (routes.length === 0) return lines;

  lines.push("", "Recent routes");
  const recent = [...routes]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);
  for (const route of recent) {
    const conversation = route.conversationId
      ? `conversation ${shortId(route.conversationId)}`
      : "conversation pending";
    lines.push(
      `  ${route.harness.padEnd(12)} ${routeStatus(route, observations).padEnd(10)} session ${shortId(route.sessionId)}  ${conversation}`,
    );
  }
  if (routes.length > recent.length) {
    lines.push(
      `  ${routes.length - recent.length} older routes; use --json for all.`,
    );
  }
  const failures = observations
    .filter(
      (observation) =>
        observation.status === "failed" ||
        observation.status === "needs_reconciliation",
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);
  if (failures.length > 0) {
    lines.push("", "Recent failures");
    for (const failure of failures) {
      lines.push(`  ${failure.status.padEnd(21)} ${failure.event.id}`);
    }
  }
  return lines;
}

export function formatStatus(
  context: StatusContext,
  options: FormatStatusOptions = {},
): string {
  const homeDirectory = options.homeDirectory ?? homedir();
  const projectPath = context.project?.projectRoot ?? context.requestedPath;
  const records = projectRecords(context);
  const observationCounts = countByStatus(records.observations);
  const timestamp = options.now ?? new Date().toISOString();
  const pendingWhispers = records.deliveries.filter(
    (delivery) =>
      delivery.kind === "whisper" &&
      delivery.status === "pending" &&
      delivery.expiresAt > timestamp,
  ).length;
  const lines = [
    "Subconscious status",
    "",
    line(
      "Broker",
      context.broker.online
        ? `online${context.broker.pid ? ` (PID ${context.broker.pid})` : ""}`
        : "offline",
    ),
    line(
      "Project",
      context.project
        ? compactPath(projectPath, homeDirectory)
        : `not configured for ${compactPath(projectPath, homeDirectory)}`,
    ),
    line(
      "Observer",
      context.project?.config.agentId
        ? `${options.detail ? context.project.config.agentId : shortId(context.project.config.agentId, 18)} (${context.project.config.model})`
        : "none",
    ),
    line(
      "Work",
      context.project
        ? statusList(observationCounts, ["processing", "queued"], {
            processing: "processing",
            queued: "queued",
          }).replace("none", "idle") +
            (!context.broker.online &&
            ((observationCounts.processing ?? 0) > 0 ||
              (observationCounts.queued ?? 0) > 0)
              ? " (broker offline)"
              : "")
        : "no configured project",
    ),
    line(
      "Whispers",
      context.project
        ? pendingWhispers > 0
          ? context.project.config.delivery.whispers
            ? `${pendingWhispers} waiting for next prompt`
            : `${pendingWhispers} waiting (delivery disabled)`
          : "none waiting"
        : "no configured project",
    ),
    ...(context.project
      ? formatFailures(records.observations)
      : [line("Failures", "no configured project")]),
  ];
  if (!context.broker.online) {
    lines.push(line("Start", "subconscious start"));
  }
  if (options.detail && context.project) {
    lines.push(
      ...formatDetail(records.routes, records.observations, records.deliveries),
    );
  }
  return lines.join("\n");
}
