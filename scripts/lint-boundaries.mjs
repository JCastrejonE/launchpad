#!/usr/bin/env node
/**
 * lint-boundaries.mjs — find the shape that cost eight defects in one day
 * (docs/COMPLIANCE-REGISTRY.md rows 25, 31, 32, 36, 39, 42, 48, 56, 61).
 *
 * Every one was the same sentence: an exported function grew an OPTIONAL
 * parameter, a second caller was added later, and nobody passed it. Two of them
 * had a correct, tested rule that could not fire because no call site supplied
 * the argument. It is docs/VERIFICATION.md #12, paid for six times.
 *
 * What this reports, per exported function with an optional parameter:
 *   DEAD      no caller anywhere passes it — either remove it or make it required
 *   TEST-ONLY only a test passes it. This is the sharper finding: the production
 *             callers all take the default, so the parameter's behaviour is
 *             exercised only by a fixture (registry row 49's family).
 *
 * HONEST LIMIT, and the first version of this note was WRONG in the dangerous
 * direction. It claimed a false DEAD was unlikely; the first run produced two,
 * both in the gate-signal path, because React server actions are passed to forms
 * as `action.bind(null, a, b, c)` and a name-matcher sees a call to `bind`. That
 * is handled now: `X.bind(null, …)` counts as a call to X with one fewer
 * argument.
 *
 * What remains true: call sites are matched BY NAME, so a same-named method on an
 * unrelated object counts as a caller, which hides real DEADs. Both error
 * directions exist. It is a review list, not a gate — promote it once the list is
 * empty and stays empty, which is the lint-specs.mjs pattern: measure, then gate.
 *
 * Usage:
 *   scripts/lint-boundaries.mjs            report
 *   scripts/lint-boundaries.mjs --strict    exit 1 if anything is DEAD
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const ts = createRequire(import.meta.url)("typescript");

const STRICT = process.argv.slice(2).includes("--strict");
const ROOTS = ["packages", "apps"];
const SKIP = /(?:^|\/)(?:node_modules|dist|\.next|drizzle)(?:\/|$)/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (SKIP.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => { try { return walk(r); } catch { return []; } });
const isTest = (f) => /\.test\.tsx?$/.test(f);

/** name -> { file, optionalFrom: index of the first optional param, params: n } */
const exported = new Map();
/** name -> { prod: maxArgs, test: maxArgs } */
const calls = new Map();

for (const file of files) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    // Exported function declarations with at least one optional parameter.
    if (ts.isFunctionDeclaration(node) && node.name && node.parameters.length > 0) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        const idx = node.parameters.findIndex((p) => p.questionToken !== undefined);
        if (idx >= 0 && !isTest(file)) {
          exported.set(node.name.text, {
            file,
            optionalFrom: idx,
            params: node.parameters.length,
            names: node.parameters.map((p) => p.name.getText(src)),
          });
        }
      }
    }
    // Call sites, by callee name.
    if (ts.isCallExpression(node)) {
      let name = null;
      let argc = node.arguments.length;
      if (ts.isIdentifier(node.expression)) {
        name = node.expression.text;
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        // `fn.bind(null, a, b)` IS a call site that supplies a and b. Next
        // passes server actions to <form action={…}> this way, so missing it
        // reported two live gate actions as dead.
        if (node.expression.name.text === "bind" && ts.isIdentifier(node.expression.expression)) {
          name = node.expression.expression.text;
          argc = Math.max(0, node.arguments.length - 1); // drop the thisArg
        } else {
          name = node.expression.name.text;
        }
      }
      if (name) {
        const rec = calls.get(name) ?? { prod: -1, test: -1 };
        const key = isTest(file) ? "test" : "prod";
        rec[key] = Math.max(rec[key], argc);
        calls.set(name, rec);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

const dead = [];
const testOnly = [];
for (const [name, info] of exported) {
  const seen = calls.get(name) ?? { prod: -1, test: -1 };
  const needed = info.optionalFrom + 1; // args required to actually pass it
  if (seen.prod < needed && seen.test < needed) dead.push({ name, info });
  else if (seen.prod < needed && seen.test >= needed) testOnly.push({ name, info });
}

const show = (list, label) => {
  if (list.length === 0) return;
  console.log(`\n${label} (${list.length})`);
  for (const { name, info } of list.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${name}(…, ${info.names[info.optionalFrom]}?)  ${info.file}`);
  }
};

console.log(`lint-boundaries: ${files.length} files, ${exported.size} exported functions with an optional parameter`);
show(dead, "DEAD — no caller passes it (remove it, or make it required)");
show(testOnly, "TEST-ONLY — only a test passes it; production always takes the default");
if (dead.length === 0 && testOnly.length === 0) console.log("\nnothing to review.");
console.log("\n(call sites matched by NAME, `.bind` included. Both error directions are possible:\n a same-named method hides a real DEAD. A review list, not a gate.)");

// ---------------------------------------------------------------------------
// Optional PROPERTIES of exported interfaces. This is the shape the 2026-08-19
// defects actually had — `ProjectCreateInput.productionHost?`,
// `ConnectInput.odooVersion?`, `DeployOptions.restoreFromProduction?` — none of
// which is a positional parameter, so the analysis above is blind to all of them.
// ---------------------------------------------------------------------------
const optionalProps = new Map(); // "Iface.prop" -> file
const writtenInProd = new Set();  // keys written in an object literal in prod code
const writtenInTest = new Set();  // ...and in tests. Both from the AST, so object
                                  // SHORTHAND counts: `{ checksConfigured }` has no
                                  // colon, and a text search for `prop + ":"` called
                                  // a live production caller test-only.

for (const file of files) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && !isTest(file)) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        for (const m of node.members) {
          if (ts.isPropertySignature(m) && m.questionToken && m.name) {
            optionalProps.set(`${node.name.text}.${m.name.getText(src)}`, file);
          }
        }
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (prop.name) {
          const key = prop.name.getText(src).replace(/^["']|["']$/g, "");
          (isTest(file) ? writtenInTest : writtenInProd).add(key);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

const propOf = (k) => k.split(".")[1];
const deadProps = [...optionalProps.entries()].filter(
  ([k]) => !writtenInProd.has(propOf(k)) && !writtenInTest.has(propOf(k)),
);
const testOnlyProps = [...optionalProps.entries()].filter(
  ([k]) => !writtenInProd.has(propOf(k)) && writtenInTest.has(propOf(k)),
);

console.log(`\noptional interface properties: ${optionalProps.size} exported`);
if (deadProps.length) {
  console.log(`\nDEAD PROPERTY — never written in any object literal (${deadProps.length})`);
  for (const [k, f] of deadProps.sort()) console.log(`  ${k}  ${f}`);
}
if (testOnlyProps.length) {
  console.log(`\nTEST-ONLY PROPERTY — only tests write it (${testOnlyProps.length})`);
  for (const [k, f] of testOnlyProps.sort()) console.log(`  ${k}  ${f}`);
}
if (!deadProps.length && !testOnlyProps.length) console.log("  none unset.");

// Read the property lists with these categories in mind, or the noise buries the
// signal. Three kinds of entry are CORRECT and expected:
//   - injection seams: `fetch`, `timeoutMs`, `maxRetries`, `store`, `generate` —
//     optional so a test can substitute them; production takes the real default.
//   - INBOUND shapes: `Raw*` interfaces describe parsed JSON. Nothing writes them
//     in production, by definition, so "unset" says nothing.
//   - deliberately unwired features: `copyProduction` has no UI yet (spec 0226),
//     which this correctly reports and the spec already records.
// What is worth acting on is an option a caller SHOULD set and does not — and
// that is exactly what this cannot see, because the defects of 2026-08-19 were
// "the branch that should pass it, does not", not "nobody passes it". See
// docs/VALIDATION-BUILD-PLAN.md: for that half, a REQUIRED parameter or a closed
// union is the fix, because it makes the wrong call fail to compile rather than
// hoping a report is read.

if (STRICT && (dead.length > 0 || deadProps.length > 0)) process.exit(1);
