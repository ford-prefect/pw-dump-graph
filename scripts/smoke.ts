// Layout smoke test (run via `npm test`, no test runner needed — just tsx).
//
// Every dump under fixtures/ must go parse → model → layout without throwing,
// with *every* node placed. That last check is the real guard: the ELK adapter
// once dropped portless grouped nodes, which both lost them from the picture and
// crashed layout on the dangling group edge (see fixtures/pw-dump-exception.json).
// Render needs a DOM, so it's out of scope here; this covers the headless pipeline.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../frontend/model.js";
import { elkLayout } from "../frontend/layout/elk.js";

const dir = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function main(): Promise<void> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  assert(files.length > 0, "no fixtures found under fixtures/");

  let failed = 0;
  for (const file of files) {
    try {
      const graph = buildGraph(JSON.parse(readFileSync(dir + file, "utf8")));
      const positioned = await elkLayout(graph);

      const placed = new Set(positioned.nodes.map((n) => n.id));
      const missing = [...graph.nodes.keys()].filter((id) => !placed.has(id));
      assert.deepEqual(missing, [], `nodes dropped from layout: ${missing.join(", ")}`);
      assert.equal(positioned.groups.length, graph.groups.length, "group count changed in layout");

      console.log(
        `ok   ${file}  (${graph.nodes.size} nodes, ${graph.links.length} links, ${graph.groups.length} groups)`,
      );
    } catch (err) {
      failed++;
      console.error(`FAIL ${file}: ${(err as Error).message}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${files.length} fixtures failed`);
    process.exit(1);
  }
  console.log(`\n${files.length} fixtures laid out cleanly`);
}

void main();
