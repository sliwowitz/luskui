import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");
const staticDir = path.join(repoRoot, "static");

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`${command} exited with code ${code}`);
      error.code = code;
      reject(error);
    });
  });

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await run(path.join(repoRoot, "node_modules", ".bin", "tsc"), [
  "--project",
  path.join(repoRoot, "tsconfig.build.json"),
  "--outDir",
  distDir,
]);
await cp(staticDir, path.join(distDir, "static"), { recursive: true });
