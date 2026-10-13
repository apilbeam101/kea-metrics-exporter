import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROMETHEUS_VERSION } from "../../../scripts/fetch-promtool.ts";
import { DASHBOARD_PATH, renderDashboard } from "../../../scripts/generate-dashboard.ts";
import { declaredFamilies } from "../../../scripts/generate-metrics-doc.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const ALERTS = read("alerts/kea.yaml");
const ALERT_TESTS = read("alerts/kea.test.yaml");
const DESIGN_QUERIES = read("test/promtool/design-queries.yaml");

interface DashboardPanel {
  readonly type: string;
  readonly title: string;
  readonly gridPos: { x: number; y: number; w: number; h: number };
  readonly targets?: ReadonlyArray<{ readonly expr: string }>;
}

const dashboard = JSON.parse(renderDashboard()) as { panels: DashboardPanel[] };
const dashboardExprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr));
const alertExprs = [...ALERTS.matchAll(/expr: (?:\|\n)?([\s\S]*?)\n\s+(?:for|labels):/g)].map(
  (m) => m[1] ?? "",
);

describe("dashboards/kea.json", () => {
  it("matches a fresh generation", () => {
    assert.equal(readFileSync(DASHBOARD_PATH, "utf8"), renderDashboard());
  });

  it("puts exporter health first and high availability second", () => {
    const rows = dashboard.panels.filter((p) => p.type === "row").map((p) => p.title);
    assert.deepEqual(rows.slice(0, 2), ["Exporter health", "High availability"]);
  });

  it("lays out panels within the grid without overlaps", () => {
    const panels = dashboard.panels;
    for (const p of panels) assert.ok(p.gridPos.x + p.gridPos.w <= 24, p.title);
    for (let i = 0; i < panels.length; i++) {
      for (let j = i + 1; j < panels.length; j++) {
        const a = panels[i]?.gridPos;
        const b = panels[j]?.gridPos;
        if (a === undefined || b === undefined) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.equal(overlap, false, `${panels[i]?.title} overlaps ${panels[j]?.title}`);
      }
    }
  });
});

describe("metric names in the dashboard, alerts and design queries", () => {
  it("all exist in the exporter's declarations", async () => {
    const { target, global } = await declaredFamilies();
    const declared = new Set([...target, ...global].map((f) => f.name));
    for (const [source, text] of [
      ["dashboard", renderDashboard()],
      ["alerts", ALERTS],
      ["alert tests", ALERT_TESTS],
      ["design queries", DESIGN_QUERIES],
    ] as const) {
      for (const [name] of text.matchAll(/\bkea_[a-z0-9_]+/g)) {
        assert.ok(declared.has(name), `${source} references undeclared metric ${name}`);
      }
    }
  });
});

describe("multi-exporter safety", () => {
  it("only sums rates, never identity-like series", () => {
    for (const expr of [...dashboardExprs, ...alertExprs]) {
      for (const match of expr.matchAll(/\bsum\b(\s*(?:by|without)\s*\([^)]*\))?\s*\(/g)) {
        const rest = expr.slice((match.index ?? 0) + match[0].length).trimStart();
        assert.match(rest, /^(rate|increase)\(/, `sum over a non-rate in: ${expr}`);
      }
    }
  });

  it("includes job and instance in every vector-matching clause", () => {
    for (const expr of [...dashboardExprs, ...alertExprs]) {
      for (const [clause] of expr.matchAll(
        /\b(?:on|ignoring|group_left|group_right)\s*\([^)]*\)/g,
      )) {
        assert.match(clause, /\bjob\b/, clause);
        assert.match(clause, /\binstance\b/, clause);
      }
    }
  });
});

describe("alerts/kea.test.yaml", () => {
  it("shows every rule both firing and not firing", () => {
    const rules = [...ALERTS.matchAll(/- alert: (\w+)/g)].map((m) => m[1] ?? "");
    assert.ok(rules.length > 0);
    for (const rule of rules) {
      const checks = [
        ...ALERT_TESTS.matchAll(new RegExp(`alertname: ${rule}\\n\\s+exp_alerts:(.*)`, "g")),
      ].map((m) => (m[1] ?? "").trim());
      assert.ok(checks.includes("[]"), `${rule} is never shown not firing`);
      assert.ok(checks.includes(""), `${rule} is never shown firing`);
    }
  });

  it("has dashboard queries that promtool parses, when promtool has been fetched", (t) => {
    const binary = join(
      root,
      ".local",
      "bin",
      PROMETHEUS_VERSION,
      process.platform === "win32" ? "promtool.exe" : "promtool",
    );
    if (!existsSync(binary)) {
      t.skip("promtool not fetched; run npm run fetch:promtool");
      return;
    }
    // Grafana variables substituted the way an "All" selection expands.
    const rules = dashboardExprs.map((expr, i) => {
      const resolved = expr.replace(/\$\w+/g, ".*");
      return `      - record: dashboard:query_${i}\n        expr: ${JSON.stringify(resolved)}`;
    });
    const dir = join(root, ".test-tmp");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `dashboard-queries-${process.pid}.yaml`);
    writeFileSync(path, `groups:\n  - name: dashboard\n    rules:\n${rules.join("\n")}\n`);
    try {
      execFileSync(binary, ["check", "rules", path], { stdio: "pipe" });
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("passes promtool, when promtool has been fetched", (t) => {
    const binary = join(
      root,
      ".local",
      "bin",
      PROMETHEUS_VERSION,
      process.platform === "win32" ? "promtool.exe" : "promtool",
    );
    if (!existsSync(binary)) {
      t.skip("promtool not fetched; run npm run fetch:promtool");
      return;
    }
    for (const args of [
      ["check", "rules", "alerts/kea.yaml"],
      ["test", "rules", "alerts/kea.test.yaml"],
      ["check", "rules", "test/promtool/design-queries.yaml"],
      ["test", "rules", "test/promtool/design-queries.test.yaml"],
    ]) {
      execFileSync(binary, args, { cwd: root, stdio: "pipe" });
    }
  });
});
