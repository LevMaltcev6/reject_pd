import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
execFileSync(
  process.env.PD_PYTHON || "python3",
  ["scripts/convert_sources.py"],
  { stdio: "inherit" },
);
const header = `// ==UserScript==
// @name         Возврат ПД — подготовка обращений
// @namespace    return-pd.local
// @version      ${version}
// @description  Рассылка по вашим шаблонам в текущей вкладке почты. Доступен режим черновиков.
// @match        https://mail.google.com/*
// @match        https://mail.yandex.ru/*
// @match        https://mail.yandex.com/*
// @match        https://mail.yandex.by/*
// @match        https://mail.yandex.kz/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==`;
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/return-pd.user.js",
  format: "iife",
  target: ["chrome110", "firefox115"],
  banner: { js: header },
  legalComments: "none",
});
console.log("Built dist/return-pd.user.js");
copyFileSync("dist/return-pd.user.js", `dist/return-pd-${version}.user.js`);
