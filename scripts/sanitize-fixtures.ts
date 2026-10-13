import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSanitizer, findLeaks, type Leak } from "../src/sanitize.ts";

// Deliberately does not catch a missing root: a typo'd --check target must
// fail the guard loudly rather than vacuously pass on an empty file list.
export function listFiles(rootPath: string): string[] {
  if (!statSync(rootPath).isDirectory()) return [rootPath];

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) walk(fullPath);
      else files.push(fullPath);
    }
  };
  walk(rootPath);
  return files.sort();
}

export interface FileCheckResult {
  file: string;
  leaks: Leak[];
}

// Markdown alongside fixtures is prose about them, where dotted identifiers
// such as `dhcp-state.disabled-by-user` read as domains. The guard is for
// fixture data.
export function checkPaths(paths: readonly string[]): FileCheckResult[] {
  const results: FileCheckResult[] = [];
  for (const path of paths) {
    for (const file of listFiles(path).filter((f) => !f.endsWith(".md"))) {
      const leaks = findLeaks(readFileSync(file, "utf8"));
      if (leaks.length > 0) results.push({ file, leaks });
    }
  }
  return results;
}

export interface SanitizeArgs {
  inputs: string[];
  outDir: string | undefined;
}

export function parseSanitizeArgs(args: readonly string[]): SanitizeArgs {
  const outIndex = args.indexOf("--out-dir");
  if (outIndex === -1) return { inputs: [...args], outDir: undefined };
  return {
    inputs: args.filter((_, i) => i !== outIndex && i !== outIndex + 1),
    outDir: args[outIndex + 1],
  };
}

function report(results: readonly FileCheckResult[]): void {
  for (const { file, leaks } of results) {
    for (const leak of leaks) console.error(`  ${file}: [${leak.kind}] ${leak.value}`);
  }
}

function runCheck(targets: readonly string[]): void {
  if (targets.length === 0) {
    console.error("Usage: sanitize-fixtures.ts --check <path...>");
    process.exit(1);
  }
  const results = checkPaths(targets);
  if (results.length > 0) {
    console.error("Sanitisation guard: sensitive content found:");
    report(results);
    process.exit(1);
  }
  console.log(`No leaks found across ${targets.length} path(s).`);
}

function runSanitize({ inputs, outDir }: SanitizeArgs): void {
  if (inputs.length === 0 || (inputs.length > 1 && outDir === undefined)) {
    console.error("Usage: sanitize-fixtures.ts <input> | --out-dir <dir> <input...>");
    process.exit(1);
  }

  const sanitizer = createSanitizer();
  const outputs = inputs.map((file) => ({
    file,
    text: sanitizer.sanitize(readFileSync(file, "utf8")),
  }));

  const residual = outputs
    .map(({ file, text }) => ({ file, leaks: findLeaks(text) }))
    .filter(({ leaks }) => leaks.length > 0);
  if (residual.length > 0) {
    console.error("Residual sensitive content after sanitising; nothing was written:");
    report(residual);
    process.exit(1);
  }

  if (outDir === undefined) {
    process.stdout.write(outputs[0]?.text ?? "");
    return;
  }
  mkdirSync(outDir, { recursive: true });
  for (const { file, text } of outputs) writeFileSync(join(outDir, basename(file)), text);
  console.log(`Sanitised ${outputs.length} file(s) into ${outDir}. Review them before committing.`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--check") runCheck(args.slice(1));
  else runSanitize(parseSanitizeArgs(args));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
