import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("start_preview returns 404 for a missing file without crashing", () => {
  const script = `
    import { startPreviewTool } from "./src/tools/utility-tools.ts";

    (async () => {
      const port = 19180;
      await startPreviewTool.execute({ port });
      const res = await fetch(\`http://127.0.0.1:\${port}/missing.js\`);
      console.log(res.status);
      process.exit(res.status === 404 ? 0 : 1);
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  const result = spawnSync("pnpm", ["exec", "tsx", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
