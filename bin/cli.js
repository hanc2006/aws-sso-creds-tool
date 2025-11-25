#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const tsxPath = join(__dirname, "..", "node_modules", ".bin", "tsx");
const appPath = join(__dirname, "..", "src", "app.ts");

const child = spawn(tsxPath, [appPath], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
