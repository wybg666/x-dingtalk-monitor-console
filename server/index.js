import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { monitorService } from "./monitorService.js";
import { ensureDataDir, readPublicConfig, readRuntimeConfig, saveConfig } from "./configStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const app = express();
const server = createServer(app);
const port = Number(process.env.PORT || 3007);
const distIndexPath = path.join(root, "dist", "index.html");
const sourceIndexPath = path.join(root, "index.html");
const isProduction =
  process.env.NODE_ENV === "production" ||
  (fs.existsSync(distIndexPath) && !fs.existsSync(sourceIndexPath));
const listenHost = "127.0.0.1";
const appUrl = `http://${listenHost}:${port}`;
const autoOpenEnabled = process.env.X_MONITOR_NO_AUTO_OPEN !== "1";

ensureDataDir();

app.use(express.json({ limit: "1mb" }));

app.get("/api/config", (_req, res) => {
  res.json(readPublicConfig());
});

app.post("/api/config", (req, res) => {
  try {
    const publicConfig = saveConfig(req.body || {});
    monitorService.log("success", "配置已保存", {
      provider: publicConfig.provider,
      usernames: publicConfig.usernames,
      mode: publicConfig.options.mode
    });
    res.json(publicConfig);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/state", (_req, res) => {
  res.json(monitorService.getSnapshot());
});

app.post("/api/browser/open", async (_req, res) => {
  try {
    const result = await monitorService.openBrowserHome();
    res.json(result);
  } catch (err) {
    monitorService.log("error", "打开本地浏览器失败", { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/start", async (_req, res) => {
  try {
    const state = await monitorService.start();
    res.json(state);
  } catch (err) {
    monitorService.log("error", "启动失败", { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/stop", async (_req, res) => {
  try {
    const state = await monitorService.stop();
    res.json(state);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/dingtalk/test", async (req, res) => {
  try {
    const result = await monitorService.testDingTalk(req.body?.dingTalkWebhook, req.body?.dingTalkSecret);
    res.json(result);
  } catch (err) {
    monitorService.log("error", "钉钉测试失败", { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sync-latest", async (_req, res) => {
  try {
    const result = await monitorService.syncLatest(readRuntimeConfig());
    res.json(result);
  } catch (err) {
    monitorService.log("error", "同步最近推文失败", { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/logs/clear", (_req, res) => {
  monitorService.clearLogs();
  res.json({ ok: true });
});

app.post("/api/seen/reset", (_req, res) => {
  res.json(monitorService.resetSeenTweets());
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  send({ id: 0, type: "snapshot", at: new Date().toISOString(), payload: monitorService.getSnapshot() });

  const onEvent = (event) => send(event);
  monitorService.on("event", onEvent);

  const heartbeat = setInterval(() => {
    send({ id: -1, type: "heartbeat", at: new Date().toISOString(), payload: {} });
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    monitorService.off("event", onEvent);
  });
});

if (isProduction) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*", (_req, res) => {
    res.sendFile(distIndexPath);
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

function openUrl(url) {
  try {
    const candidates =
      process.platform === "win32"
        ? [
            path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
            path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
            path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
          ].filter(Boolean)
        : [];
    const appBrowser = candidates.find((item) => fs.existsSync(item));
    if (appBrowser) {
      const child = spawn(appBrowser, [`--app=${url}`, "--new-window", "--window-size=1280,900"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
      return;
    }

    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
      return;
    }
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // 打开浏览器失败不影响服务本身。
  }
}

server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.log(`推文监控台已经在运行：${appUrl}`);
    if (autoOpenEnabled) {
      console.log("已为你打开现有桌面窗口；无需重复启动。");
      openUrl(appUrl);
    }
    process.exit(0);
  }

  console.error(err);
  process.exit(1);
});

server.listen(port, listenHost, () => {
  console.log(`推文监控台已启动：${appUrl}`);
  if (autoOpenEnabled) openUrl(appUrl);
});
