// Serves the demo app at http://127.0.0.1:4317 (or the port given).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const page = readFileSync(fileURLToPath(new URL("index.html", import.meta.url)));
const port = +(process.argv[2] || 4317);
createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/?") || req.url === "/index.html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(page); }
  else { res.writeHead(404); res.end(); }
}).listen(port, "127.0.0.1", () => console.log(`Sprout demo at http://127.0.0.1:${port}`));
