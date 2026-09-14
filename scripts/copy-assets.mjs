// The compiler only emits JavaScript; n8n also needs the node icons and the
// codex files next to the compiled nodes.
import { cp, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const source = join(root, "nodes", "Tiro");
const target = join(root, "dist", "nodes", "Tiro");

for (const name of await readdir(source)) {
  if (name.endsWith(".svg") || name.endsWith(".json")) {
    await cp(join(source, name), join(target, name));
  }
}
