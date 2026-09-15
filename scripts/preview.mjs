// Isolated UI preview: no connection to a real mailbox and no draft creation.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/app.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(
      readFileSync(new URL("../dist/return-pd.user.js", import.meta.url)),
    );
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Обращения по ПД — локальный предпросмотр</title>
<body style="font:16px system-ui;background:#edf2ed;padding:40px;color:#204c3c"><h1>Предпросмотр интерфейса</h1><p>Откройте панель справа внизу. Эта страница не подключена к почте; открытие писем отключено.</p>
<script>const values=new Map(); window.GM_getValue=(k,d)=>values.has(k)?values.get(k):d;window.GM_setValue=(k,v)=>values.set(k,structuredClone(v));window.GM_deleteValue=k=>values.delete(k);window.GM_listValues=()=>[...values.keys()];window.GM_registerMenuCommand=()=>{};window.GM_setClipboard=t=>navigator.clipboard.writeText(t);</script><script src="/app.js"></script></body></html>`);
});
server.listen(4173, "127.0.0.1", () =>
  console.log("UI preview: http://127.0.0.1:4173"),
);
