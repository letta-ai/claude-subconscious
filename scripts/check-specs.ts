import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SPEC_DIRECTORY = join(process.cwd(), "specs");
const STATUS_PATH = join(SPEC_DIRECTORY, "STATUS.md");
const STATUSES = new Set([
  "draft",
  "approved",
  "implementing",
  "implemented",
  "superseded",
]);

interface SpecMetadata {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  file: string;
}

function parseArray(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "[]") return [];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Expected a YAML array, received ${value}.`);
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseSpec(file: string, text: string): SpecMetadata {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`${file} has no YAML frontmatter.`);
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  const id = fields.get("id");
  const title = fields.get("title");
  const status = fields.get("status");
  if (!id || !title || !status)
    throw new Error(`${file} is missing id, title, or status.`);
  if (!STATUSES.has(status))
    throw new Error(`${file} has unsupported status ${status}.`);
  if (!file.startsWith(`${id}-`))
    throw new Error(`${file} must start with ${id}-.`);
  return {
    id,
    title,
    status,
    dependencies: parseArray(fields.get("dependencies") ?? "[]"),
    file,
  };
}

function checkDependencies(specs: SpecMetadata[]): void {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  for (const spec of specs) {
    for (const dependency of spec.dependencies) {
      if (!byId.has(dependency))
        throw new Error(`${spec.id} depends on missing ${dependency}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id))
      throw new Error(`Specification dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? [])
      visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const spec of specs) visit(spec.id);
}

function statusText(specs: SpecMetadata[]): string {
  const rows = specs
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (spec) =>
        `| ${spec.id} | ${spec.title} | ${spec.status} | ${spec.dependencies.join(", ") || "None"} |`,
    );
  return [
    "# Specification status",
    "",
    "| ID | Title | Status | Dependencies |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const files = (await readdir(SPEC_DIRECTORY)).filter(
    (file) => file.startsWith("SPEC-") && file.endsWith(".md"),
  );
  const specs = await Promise.all(
    files.map(async (file) =>
      parseSpec(file, await readFile(join(SPEC_DIRECTORY, file), "utf8")),
    ),
  );
  checkDependencies(specs);
  const expected = statusText(specs);
  if (process.argv.includes("--update")) {
    await writeFile(STATUS_PATH, expected, "utf8");
    return;
  }
  const current = await readFile(STATUS_PATH, "utf8");
  if (current !== expected)
    throw new Error(
      "specs/STATUS.md is stale. Run npm run spec:check -- --update.",
    );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
