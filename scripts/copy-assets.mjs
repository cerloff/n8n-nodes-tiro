// The compiler only emits JavaScript; n8n also needs the node icons and the
// codex files next to the compiled nodes.
import { cp, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

// Node icons and codex files, plus the credential icon n8n's verification asks for.
for (const parts of [["nodes", "Tiro"], ["credentials"]]) {
  const source = join(root, ...parts);
  const target = join(root, "dist", ...parts);
  for (const name of await readdir(source)) {
    if (name.endsWith(".svg") || name.endsWith(".json")) {
      await cp(join(source, name), join(target, name));
    }
  }
}
