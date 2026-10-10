import EventEmitter from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, readRecords, readRuntimeConfig, readSeenTweetIds, writeRecords, writeSeenTweetIds } from "./configStore.js";

const STREAM_RULES_URL = "https://api.x.com/2/tweets/search/stream/rules";
const STREAM_URL = "https://api.x.com/2/tweets/search/stream";
const RECENT_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";
const RULE_TAG = "dingtalk-monitor-console";
const SEEN_TWEETS_LIMIT = 20000;
const BROWSER_CHANNELS = [
  { id: "posts", label: "帖子" },
  { id: "replies", label: "回复" },
  { id: "subscriptions", label: "订阅" }
];
const BROWSER_CHANNEL_LABELS = Object.fromEntries(BROWSER_CHANNELS.map((channel) => [channel.id, channel.label]));

function nowIso() {
  return new Date().toISOString();
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    }
  });
}

async function readErrorBody(res) {
  const text = await res.text().catch(() => "");
  return text.slice(0, 1200);
}

function buildQuery(usernames, options) {
  const cleanUsers = usernames.map((u) => u.replace(/^@/, "").trim()).filter(Boolean);
  const fromPart =
    cleanUsers.length === 1
      ? `from:${cleanUsers[0]}`
      : `(${cleanUsers.map((u) => `from:${u}`).join(" OR ")})`;

  const filters = [];
  if (options.filterRetweets) filters.push("-is:retweet");
  if (options.originalOnly) filters.push("-is:reply", "-is:quote");
  return [fromPart, ...filters].join(" ");
}

function formatTweetUrl(username, tweetId) {
  return `https://x.com/${username}/status/${tweetId}`;
}

function safeSnippet(text = "") {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 180);
}

function normalizeUsername(value = "") {
  return String(value || "").replace(/^@/, "").trim().toLowerCase();
}

function getEnabledBrowserChannels(config = {}) {
  const selected = config.options?.monitorChannels || {};
  const channels = BROWSER_CHANNELS.filter((channel) => selected[channel.id] !== false);
  return channels.length ? channels : [BROWSER_CHANNELS[0]];
}

function browserChannelLabel(channelId) {
  return BROWSER_CHANNEL_LABELS[channelId] || channelId || "未知";
}

function dedupeTweetsById(tweets = []) {
  const seen = new Set();
  const result = [];
  for (const tweet of tweets) {
    const tweetId = String(tweet?.tweetId || "").trim();
    if (!tweetId || seen.has(tweetId)) continue;
    seen.add(tweetId);
    result.push(tweet);
  }
  return result;
}

function dingTalkBody(text = "", maxLength = 3500) {
  const normalized = String(text || "").trim();
  if (!normalized) return "（无文本内容）";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n\n…（内容过长已截断，点击原文查看完整内容）`;
}

function markdownQuote(text = "") {
  return dingTalkBody(text)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function uniqueNonEmpty(values = [], limit = 10) {
  return [
    ...new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ].slice(0, limit);
}

const A_SHARE_CODE_PATTERN = "(?:000|001|002|003|300|301|600|601|603|605|688|689|430|82\\d|83\\d|87\\d|88\\d|920)\\d{3}";
const A_SHARE_CODE_FIRST_RE = new RegExp(`(^|[^0-9A-Za-z])\\$?(${A_SHARE_CODE_PATTERN})(?:\\s*[.:-]?\\s*(SH|SS|SZ|BJ))?(?=$|[^0-9A-Za-z])`, "gi");
const A_SHARE_MARKET_FIRST_RE = new RegExp(`(^|[^0-9A-Za-z])(?:SH|SS|SZ|BJ)\\s*[.:-]?\\s*(${A_SHARE_CODE_PATTERN})(?=$|[^0-9A-Za-z])`, "gi");

function normalizeAshareMarket(value = "") {
  const upper = String(value || "").trim().toUpperCase();
  if (upper === "SS") return "SH";
  return ["SH", "SZ", "BJ"].includes(upper) ? upper : "";
}

function inferAshareMarket(code = "") {
  if (/^(000|001|002|003|300|301)/.test(code)) return "SZ";
  if (/^(600|601|603|605|688|689)/.test(code)) return "SH";
  if (/^(430|82\d|83\d|87\d|88\d|920)/.test(code)) return "BJ";
  return "";
}

function formatAshareCode(code = "", market = "") {
  const normalizedCode = String(code || "").trim();
  const normalizedMarket = normalizeAshareMarket(market) || inferAshareMarket(normalizedCode);
  return normalizedMarket ? `${normalizedCode}.${normalizedMarket}` : normalizedCode;
}

function upsertAshareMention(map, code, market, sourceLabel, matchedText) {
  const normalizedCode = String(code || "").trim();
  if (!normalizedCode) return;
  const normalizedMarket = normalizeAshareMarket(market) || inferAshareMarket(normalizedCode);
  const key = `${normalizedCode}.${normalizedMarket || "A"}`;
  const existing =
    map.get(key) || {
      code: normalizedCode,
      market: normalizedMarket,
      display: formatAshareCode(normalizedCode, normalizedMarket),
      matchedTexts: [],
      sources: []
    };
  const text = String(matchedText || "").replace(/^\W+|\W+$/g, "").trim();
  if (text && !existing.matchedTexts.includes(text)) existing.matchedTexts.push(text);
  if (sourceLabel && !existing.sources.includes(sourceLabel)) existing.sources.push(sourceLabel);
  map.set(key, existing);
}

function extractAshareCodesFromTexts(items = []) {
  const mentions = new Map();

  for (const item of items) {
    const text = String(item?.text || "");
    if (!text.trim()) continue;
    const sourceLabel = item?.label || "正文";

    A_SHARE_CODE_FIRST_RE.lastIndex = 0;
    for (const match of text.matchAll(A_SHARE_CODE_FIRST_RE)) {
      upsertAshareMention(mentions, match[2], match[3], sourceLabel, match[0]);
    }

    A_SHARE_MARKET_FIRST_RE.lastIndex = 0;
    for (const match of text.matchAll(A_SHARE_MARKET_FIRST_RE)) {
      const market = normalizeAshareMarket((match[0].match(/\b(SH|SS|SZ|BJ)\b/i) || [])[1]);
      upsertAshareMention(mentions, match[2], market, sourceLabel, match[0]);
    }
  }

  return Array.from(mentions.values());
}

function imageMarkdownLines(imageUrls = [], heading = "图片") {
  const urls = uniqueNonEmpty(imageUrls, 8);
  if (!urls.length) return [];
  return [
    "",
    `#### ${heading}`,
    ...urls.map((url, index) => `![${heading}${index + 1}](${url})`)
  ];
}

function splitTranslateChunks(text = "", maxLength = 1200) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];

  const parts = normalized.split(/(\n+)/);
  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const part of parts) {
    if (!part) continue;
    if (part.length > maxLength) {
      pushCurrent();
      for (let index = 0; index < part.length; index += maxLength) {
        chunks.push(part.slice(index, index + maxLength));
      }
      continue;
    }
    if ((current + part).length > maxLength) pushCurrent();
    current += part;
  }

  pushCurrent();
  return chunks;
}

async function translateToChinese(text = "") {
  const chunks = splitTranslateChunks(text);
  if (!chunks.length) return { text: "", sourceLang: "" };

  const translatedChunks = [];
  let sourceLang = "";

  for (const chunk of chunks) {
    const params = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: "zh-CN",
      dt: "t",
      q: chunk
    });
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });
    if (!res.ok) {
      throw new Error(`翻译接口 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }
    const payload = await res.json();
    const translated = (payload?.[0] || []).map((item) => item?.[0] || "").join("").trim();
    if (translated) translatedChunks.push(translated);
    sourceLang = sourceLang || payload?.[2] || "";
    await wait(200);
  }

  return {
    text: translatedChunks.join("\n").trim(),
    sourceLang
  };
}

function buildDingTalkSignedWebhook(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = encodeURIComponent(
    crypto.createHmac("sha256", secret).update(stringToSign).digest("base64")
  );
  const separator = webhook.includes("?") ? "&" : "?";
  return `${webhook}${separator}timestamp=${timestamp}&sign=${sign}`;
}

function chromeCandidates() {
  const env = process.env;
  return [
    env.CHROME_PATH,
    path.join(env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    env.MSEDGE_PATH,
    path.join(env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);
}

function findChromeExecutable() {
  return chromeCandidates().find((candidate) => fs.existsSync(candidate));
}

export class MonitorService extends EventEmitter {
  constructor() {
    super();
    this.state = {
      running: false,
      connected: false,
      startedAt: null,
      stoppedAt: null,
      lastError: "",
      retryAttempt: 0,
      usernamesCount: 0,
      todayPush: 0,
      totalPush: 0,
      lastPushAt: null,
      dingtalkOk: false,
      provider: "browser",
      mode: "poll",
      currentRule: ""
    };
    this.logs = [];
    this.records = readRecords();
    this.seenTweetIds = new Set([
      ...readSeenTweetIds(),
      ...this.records.map((item) => item.tweetId).filter(Boolean)
    ]);
    this.baselineUsers = new Set();
    this.abortController = null;
    this.loopPromise = null;
    this.eventSeq = 0;
    this.browserContext = null;
    this.browserPage = null;
    this.browserPages = new Map();
    this.resetTodayCounter();
    this.persistSeenTweets();
  }

  resetTodayCounter() {
    const today = new Date().toISOString().slice(0, 10);
    this.state.todayPush = this.records.filter((item) => item.createdAt?.startsWith(today)).length;
    this.state.totalPush = this.records.length;
  }

  emitEvent(type, payload = {}) {
    const event = { id: ++this.eventSeq, type, at: nowIso(), payload };
    this.emit("event", event);
    return event;
  }

  log(level, message, meta = {}) {
    const item = { id: ++this.eventSeq, at: nowIso(), level, message, meta };
    this.logs.unshift(item);
    this.logs = this.logs.slice(0, 300);
    this.emit("event", { id: item.id, type: "log", at: item.at, payload: item });
    return item;
  }

  updateState(patch) {
    this.state = { ...this.state, ...patch };
    this.emitEvent("state", this.getState());
  }

  getState() {
    return { ...this.state };
  }

  getSnapshot() {
    return {
      state: this.getState(),
      logs: this.logs,
      records: this.records.slice(0, 80)
    };
  }

  clearLogs() {
    this.logs = [];
    this.emitEvent("logs-cleared", {});
  }

  resetSeenTweets() {
    this.seenTweetIds = new Set();
    this.baselineUsers = new Set();
    this.persistSeenTweets();
    this.log("success", "已重置本次运行去重/基线状态", {
      note: "如果要重新推送当前页面历史推文，请关闭“首次只建基线”再点“同步最近”"
    });
    return { ok: true };
  }

  persistSeenTweets() {
    writeSeenTweetIds(Array.from(this.seenTweetIds).slice(-SEEN_TWEETS_LIMIT));
  }

  markTweetsSeen(tweetIds = []) {
    let changed = false;
    for (const tweetId of tweetIds) {
      const id = String(tweetId || "").trim();
      if (!id || this.seenTweetIds.has(id)) continue;
      this.seenTweetIds.add(id);
      changed = true;
    }
    if (this.seenTweetIds.size > SEEN_TWEETS_LIMIT) {
      this.seenTweetIds = new Set(Array.from(this.seenTweetIds).slice(-SEEN_TWEETS_LIMIT));
      changed = true;
    }
    if (changed) this.persistSeenTweets();
    return changed;
  }

  validateConfig(config) {
    if (config.provider === "x-api" && !config.xBearerToken) {
      throw new Error("缺少 X Bearer Token，请在界面里保存官方 X API Bearer Token");
    }
    if (!config.dingTalkWebhook) {
      throw new Error("缺少钉钉 Webhook，请在界面里保存机器人地址");
    }
    if (!config.usernames.length) {
      throw new Error("请至少填写一个要监控的 X/Twitter 用户名");
    }
  }

  async xFetch(url, config, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.xBearerToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      throw new Error(`X API ${res.status}: ${await readErrorBody(res)}`);
    }
    return res;
  }

  async ensureBrowserContext(config = readRuntimeConfig()) {
    if (this.browserContext) {
      try {
        this.browserContext.pages();
        return this.browserContext;
      } catch {
        this.browserContext = null;
        this.browserPage = null;
        this.browserPages = new Map();
      }
    }

    const { chromium } = await import("playwright-core");
    const userDataDir = path.join(DATA_DIR, "browser-profile-chrome");
    fs.mkdirSync(userDataDir, { recursive: true });

    const baseOptions = {
      headless: config.options.browserHeadless === true,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      args: ["--disable-blink-features=AutomationControlled"]
    };

    const executablePath = findChromeExecutable();
    const launchAttempts = [
      { channel: "chrome", label: "Google Chrome" },
      { channel: "msedge", label: "Microsoft Edge" },
      executablePath ? { executablePath, label: executablePath } : null
    ].filter(Boolean);

    let lastError;
    for (const attempt of launchAttempts) {
      try {
        const { label, ...launchOption } = attempt;
        const context = await chromium.launchPersistentContext(userDataDir, {
          ...baseOptions,
          ...launchOption
        });
        this.browserContext = context;
        this.browserContext.setDefaultTimeout(15000);
        this.browserContext.on("close", () => {
          this.browserContext = null;
          this.browserPage = null;
          this.browserPages = new Map();
          this.log("warn", "本地浏览器已关闭；下次操作会自动重新打开");
        });
        this.log("success", "本地浏览器已启动", { browser: label });
        return this.browserContext;
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(`无法启动本机 Chrome/Edge：${lastError?.message || "未找到浏览器"}`);
  }

  async openBrowserHome() {
    const config = readRuntimeConfig();
    const page = await this.getBrowserPage(config, "home");
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    this.log("info", "已打开本地 X 浏览器窗口；如果未登录，请先在该窗口手动登录");
    return { ok: true };
  }

  async getBrowserPage(config, username = "home") {
    const context = await this.ensureBrowserContext(config);
    const key = normalizeUsername(username) || "home";

    try {
      const cachedPage = this.browserPages.get(key);
      if (cachedPage && !cachedPage.isClosed()) return cachedPage;
    } catch {
      this.browserPages.delete(key);
    }

    const pages = context.pages().filter((page) => {
      try {
        return !page.isClosed();
      } catch {
        return false;
      }
    });

    const pageMatchesUser = (page, userKey) => {
      try {
        const currentUrl = new URL(page.url());
        const hostOk = /(^|\.)x\.com$/i.test(currentUrl.hostname) || /(^|\.)twitter\.com$/i.test(currentUrl.hostname);
        const firstPathPart = decodeURIComponent(currentUrl.pathname).split("/").filter(Boolean)[0] || "";
        return hostOk && normalizeUsername(firstPathPart) === userKey;
      } catch {
        return false;
      }
    };

    let page =
      key === "home"
        ? pages.find((item) => {
            try {
              const currentUrl = new URL(item.url());
              return /(^|\.)x\.com$/i.test(currentUrl.hostname) || /(^|\.)twitter\.com$/i.test(currentUrl.hostname);
            } catch {
              return false;
            }
          }) || pages[0]
        : pages.find((item) => pageMatchesUser(item, key));

    page = page || (await context.newPage());

    this.browserPages.set(key, page);
    if (key === "home") this.browserPage = page;
    return page;
  }

  async start() {
    if (this.state.running) {
      this.log("warn", "监控已经在运行");
      return this.getState();
    }

    const config = readRuntimeConfig();
    this.validateConfig(config);

    this.abortController = new AbortController();
    const rule =
      config.provider === "browser"
        ? `本地浏览器多频道轮询：${getEnabledBrowserChannels(config).map((channel) => channel.label).join("、")}`
        : buildQuery(config.usernames, config.options);
    const mode = config.provider === "browser" ? "poll" : config.options.mode;
    this.updateState({
      running: true,
      connected: false,
      startedAt: nowIso(),
      stoppedAt: null,
      lastError: "",
      retryAttempt: 0,
      usernamesCount: config.usernames.length,
      provider: config.provider,
      mode,
      currentRule: rule
    });
    this.log("info", "启动监控", { provider: config.provider, mode, rule });

    this.loopPromise = this.runLoop(config, rule, this.abortController.signal).catch((err) => {
      if (err?.name !== "AbortError") {
        this.log("error", "监控循环退出", { error: err.message });
        this.updateState({ running: false, connected: false, lastError: err.message });
      }
    });

    return this.getState();
  }

  async stop() {
    if (!this.state.running) {
      this.log("warn", "监控当前未运行");
      return this.getState();
    }
    this.abortController?.abort();
    this.updateState({ running: false, connected: false, stoppedAt: nowIso() });
    this.log("info", "已停止监控");
    return this.getState();
  }

  async runLoop(initialConfig, initialRule, signal) {
    if (initialConfig.provider === "browser" || initialConfig.options.mode === "poll") {
      await this.runPollingLoop(initialConfig, initialRule, signal);
      return;
    }

    await this.syncStreamRules(initialConfig, initialRule, signal);

    let retryMs = 3000;
    while (!signal.aborted && this.state.running) {
      try {
        await this.openStream(initialConfig, signal);
        if (!initialConfig.options.autoReconnect) break;
      } catch (err) {
        if (err?.name === "AbortError" || signal.aborted) break;
        const nextRetryAttempt = this.state.retryAttempt + 1;
        this.updateState({ connected: false, retryAttempt: nextRetryAttempt, lastError: err.message });
        this.log("error", "实时流断开，准备重连", {
          error: err.message,
          retrySeconds: Math.round(retryMs / 1000)
        });
        if (!initialConfig.options.autoReconnect) break;
        await wait(retryMs, signal);
        retryMs = Math.min(retryMs * 2, 60000);
      }
    }
  }

  async syncStreamRules(config, rule, signal) {
    this.log("info", "同步 Filtered Stream 规则", { rule });
    const rulesRes = await this.xFetch(STREAM_RULES_URL, config, { signal });
    const rulesJson = await rulesRes.json();
    const ownRuleIds = (rulesJson.data || []).filter((item) => item.tag === RULE_TAG).map((item) => item.id);

    if (ownRuleIds.length) {
      await this.xFetch(STREAM_RULES_URL, config, {
        method: "POST",
        signal,
        body: JSON.stringify({ delete: { ids: ownRuleIds } })
      });
    }

    await this.xFetch(STREAM_RULES_URL, config, {
      method: "POST",
      signal,
      body: JSON.stringify({ add: [{ value: rule, tag: RULE_TAG }] })
    });
    this.log("success", "规则同步完成", { rule });
  }

  async openStream(config, signal) {
    const params = new URLSearchParams({
      "tweet.fields": "created_at,author_id",
      expansions: "author_id",
      "user.fields": "username,name"
    });

    const res = await this.xFetch(`${STREAM_URL}?${params.toString()}`, config, { signal });
    this.updateState({ connected: true, retryAttempt: 0, lastError: "" });
    this.log("success", "已连接 X 实时流");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted && this.state.running) {
      const { value, done } = await reader.read();
      if (done) throw new Error("X stream ended");

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const payload = JSON.parse(trimmed);
        await this.handleXTweetPayload(payload, config);
      }
    }
  }

  async runPollingLoop(config, rule, signal) {
    const intervalMs = Math.max(20, Number(config.options.pollIntervalSec || 60)) * 1000;
    this.updateState({ connected: true });
    this.log("success", "已进入轮询模式", {
      provider: config.provider,
      intervalSeconds: Math.round(intervalMs / 1000),
      rule
    });

    while (!signal.aborted && this.state.running) {
      try {
        await this.syncLatest(config, { silentIfEmpty: true });
        this.updateState({ connected: true, lastError: "" });
      } catch (err) {
        if (err?.name === "AbortError" || signal.aborted) break;
        this.updateState({ connected: false, lastError: err.message });
        this.log("error", "轮询失败", { error: err.message });
      }
      await wait(intervalMs, signal);
    }
  }

  async syncLatest(config = readRuntimeConfig(), options = {}) {
    this.validateConfig(config);
    if (config.provider === "browser") {
      return this.syncLatestFromBrowser(config, options);
    }
    return this.syncLatestFromXApi(config, options);
  }

  async syncLatestFromBrowser(config) {
    let pushed = 0;
    let found = 0;
    const channels = getEnabledBrowserChannels(config);
    for (const username of config.usernames) {
      const userKey = normalizeUsername(username);
      const channelTweets = [];
      for (const channel of channels) {
        try {
          let tweets = await this.scrapeProfileTweets(userKey, config, channel);
          if (!tweets.length) {
            await wait(3000);
            const retryTweets = await this.scrapeProfileTweets(userKey, config, channel);
            if (retryTweets.length) {
              this.log("info", `@${userKey} ${channel.label}频道二次扫描恢复`, {
                channel: channel.id,
                firstCount: 0,
                retryCount: retryTweets.length
              });
              tweets = retryTweets;
            }
          }
          found += tweets.length;
          channelTweets.push(...tweets);
          this.log("info", `@${userKey} ${channel.label}频道扫描完成`, {
            channel: channel.id,
            count: tweets.length
          });
        } catch (err) {
          this.log("warn", `@${userKey} ${channel.label}频道扫描失败`, {
            channel: channel.id,
            error: err.message
          });
        }
      }

      const tweets = dedupeTweetsById(channelTweets).sort(
        (a, b) => Date.parse(b.tweetCreatedAt || 0) - Date.parse(a.tweetCreatedAt || 0)
      );

      if (!tweets.length) {
        this.log("warn", `@${userKey} 页面没有识别到通过作者校验的新内容`, {
          channels: channels.map((channel) => channel.id),
          hint: "如出现登录页，请点“打开/登录 X”先手动登录；如订阅频道未出现，请确认该账号页面是否展示“订阅”标签"
        });
        continue;
      }

      if (config.options.baselineOnlyOnStart && !this.baselineUsers.has(userKey)) {
        this.markTweetsSeen(tweets.map((tweet) => tweet.tweetId));
        this.baselineUsers.add(userKey);
        this.log("info", `@${userKey} 首次建立多频道基线`, {
          count: tweets.length,
          channels: channels.map((channel) => channel.id),
          latest: tweets[0]?.tweetId,
          latestCreatedAt: tweets[0]?.tweetCreatedAt
        });
        continue;
      }

      for (const tweet of tweets.slice().reverse()) {
        const didPush = await this.handleNormalizedTweet(tweet, config);
        if (didPush) pushed += 1;
      }
    }
    this.log("success", "浏览器页面同步完成", { found, pushed });
    return { found, pushed };
  }

  async resolveBrowserChannelUrl(page, username, channel) {
    const cleanUsername = normalizeUsername(username);
    const baseUrl = `https://x.com/${encodeURIComponent(cleanUsername)}`;
    if (channel.id === "posts") return baseUrl;
    if (channel.id === "replies") return `${baseUrl}/with_replies`;

    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);

    const subscriptionUrl = await page.evaluate(({ screenName }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const targetPathPrefix = `/${String(screenName || "").toLowerCase()}`;
      const anchors = Array.from(document.querySelectorAll('a[role="tab"], nav a, a[href*="/"]'));

      for (const anchor of anchors) {
        const text = normalize(anchor.innerText || anchor.textContent || "");
        if (!/(订阅|subscriptions?|subscribe)/i.test(text)) continue;
        const href = anchor.href || anchor.getAttribute("href") || "";
        if (!href) continue;
        try {
          const url = new URL(href, location.origin);
          const pathname = decodeURIComponent(url.pathname).toLowerCase();
          if (!pathname.startsWith(targetPathPrefix)) continue;
          return url.toString();
        } catch {}
      }
      return "";
    }, { screenName: cleanUsername });

    if (!subscriptionUrl) {
      this.log("warn", `@${cleanUsername} 未找到订阅频道入口`, {
        channel: channel.id,
        hint: "该账号页面当前未暴露“订阅/Subscriptions”标签，已跳过订阅频道"
      });
    }
    return subscriptionUrl;
  }

  async scrapeProfileTweets(username, config, channel = BROWSER_CHANNELS[0]) {
    const cleanUsername = normalizeUsername(username);
    const page = await this.getBrowserPage(config, cleanUsername);
    const url = await this.resolveBrowserChannelUrl(page, cleanUsername, channel);
    if (!url) return [];
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5000);

    const tweets = await page.evaluate(({ screenName, options, channel }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cleanText = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .split(/\n+/)
          .map((line) => line.replace(/[ \t]+/g, " ").trim())
          .filter(Boolean)
          .join("\n");
      const normalizeHandle = (value) => String(value || "").replace(/^@/, "").trim().toLowerCase();
      const target = normalizeHandle(screenName);
      const sourceChannel = channel?.id || "posts";
      const sourceLabel = channel?.label || sourceChannel;
      const result = [];
      const seen = new Set();

      const parseStatusLink = (link) => {
        const href = link?.href || link?.getAttribute?.("href") || "";
        if (!href) return null;
        try {
          const url = new URL(href, location.origin);
          const path = decodeURIComponent(url.pathname);
          const match = path.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
          if (!match) return null;
          return { handle: normalizeHandle(match[1]), id: match[2], link, path };
        } catch {
          const match = href.match(/\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
          return match ? { handle: normalizeHandle(match[1]), id: match[2], link, path: href } : null;
        }
      };

      const readAuthorHandles = (article) => {
        const userNameBlocks = Array.from(article.querySelectorAll('[data-testid="User-Name"]'));
        const firstBlockText = normalize(userNameBlocks[0]?.innerText || userNameBlocks[0]?.textContent || "");
        const allText = normalize(userNameBlocks.map((node) => node.innerText || node.textContent || "").join(" "));
        const firstHandles = Array.from(firstBlockText.matchAll(/@([A-Za-z0-9_]{1,15})/g)).map((m) => normalizeHandle(m[1]));
        const allHandles = Array.from(allText.matchAll(/@([A-Za-z0-9_]{1,15})/g)).map((m) => normalizeHandle(m[1]));
        return { firstHandles, allHandles };
      };

      const findEditedAt = (article, rawArticleText, publishedAt) => {
        if (!/(?:last\s*edited|edited|已编辑|已編輯|编辑|編輯)/i.test(rawArticleText)) return "";
        const otherTime = Array.from(article.querySelectorAll("time[datetime]"))
          .map((node) => node.getAttribute("datetime") || "")
          .find((value) => value && value !== publishedAt);
        return otherTime || "页面显示已编辑（未识别具体时间）";
      };

      for (const article of Array.from(document.querySelectorAll("article"))) {
        const rawArticleText = normalize(article.innerText || article.textContent || "");
        if (!rawArticleText) continue;
        if (/Pinned|置顶|已置顶/i.test(rawArticleText)) continue;
        if (/Promoted|广告|廣告/i.test(rawArticleText)) continue;
        if (options?.filterRetweets && /reposted|转发|转推/i.test(rawArticleText)) continue;
        const applyOriginalOnly = options?.originalOnly && sourceChannel === "posts";
        if (applyOriginalOnly && /Replying to|回复给|正在回复|回覆給/i.test(rawArticleText)) continue;

        const { firstHandles, allHandles } = readAuthorHandles(article);
        const authorHandle = firstHandles[0] || allHandles[0] || "";
        if (!authorHandle || authorHandle !== target) continue;

        const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'))
          .map(parseStatusLink)
          .filter(Boolean);
        const ownStatusLinks = statusLinks.filter((item) => item.handle === target);
        if (!ownStatusLinks.length) continue;

        if (applyOriginalOnly && statusLinks.some((item) => item.handle !== target)) continue;

        const primaryStatus =
          ownStatusLinks.find((item) => item.link.querySelector("time[datetime]")) || ownStatusLinks[0];
        const tweetId = primaryStatus.id;
        if (!tweetId || seen.has(tweetId)) continue;

        const timeNode =
          primaryStatus.link.querySelector("time[datetime]") ||
          article.querySelector(`a[href*="/${target}/status/${tweetId}"] time[datetime]`) ||
          article.querySelector("time[datetime]");
        const publishedAt = timeNode?.getAttribute("datetime") || "";
        if (!publishedAt) continue;

        const tweetTextNodes = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
        const tweetTextNode = tweetTextNodes[0];
        const text = cleanText(tweetTextNode?.innerText || tweetTextNode?.textContent || "");
        if (!text) continue;

        seen.add(tweetId);
        result.push({
          tweetId,
          username: target,
          matchedAuthor: authorHandle,
          authorVerified: authorHandle === target && ownStatusLinks.length > 0,
          name: "",
          text: text.slice(0, 3500),
          url: `https://x.com/${target}/status/${tweetId}`,
          tweetCreatedAt: publishedAt,
          tweetEditedAt: findEditedAt(article, rawArticleText, publishedAt),
          sourceChannel,
          sourceLabel
        });
      }

      return result
        .sort((a, b) => Date.parse(b.tweetCreatedAt || 0) - Date.parse(a.tweetCreatedAt || 0))
        .slice(0, 5);
    }, { screenName: cleanUsername, options: config.options, channel });

    const enriched = [];
    for (const tweet of tweets) {
      if (this.seenTweetIds.has(tweet.tweetId)) {
        enriched.push(tweet);
        continue;
      }

      try {
        enriched.push(await this.enrichTweetFromDetail(page, tweet, config));
      } catch (err) {
        this.log("warn", "详情页全文抓取失败，使用列表页摘要", {
          tweetId: tweet.tweetId,
          error: err.message
        });
        enriched.push(tweet);
      }
    }

    return enriched;
  }

  async enrichTweetFromDetail(page, tweet, config) {
    const mainDetail = await this.scrapeTweetDetail(page, tweet.url, tweet.username, tweet.tweetId);
    const next = {
      ...tweet,
      ...mainDetail,
      text: mainDetail.text || tweet.text || "",
      imageUrls: uniqueNonEmpty([...(tweet.imageUrls || []), ...(mainDetail.imageUrls || [])], 8)
    };

    if (config.options.includeQuotedTweet !== false && mainDetail.quotedTweet?.url) {
      const quoted = mainDetail.quotedTweet;
      try {
        const quotedDetail = await this.scrapeTweetDetail(
          page,
          quoted.url,
          quoted.username || quoted.matchedAuthor || "",
          quoted.tweetId
        );
        next.quotedTweet = {
          ...quoted,
          ...quotedDetail,
          text: quotedDetail.text || quoted.text || "",
          imageUrls: uniqueNonEmpty([...(quoted.imageUrls || []), ...(quotedDetail.imageUrls || [])], 8)
        };
      } catch (err) {
        this.log("warn", "原推文详情页抓取失败，使用引用卡片摘要", {
          tweetId: tweet.tweetId,
          quotedTweetId: quoted.tweetId,
          error: err.message
        });
        next.quotedTweet = quoted;
      }
    } else if (mainDetail.quotedTweet?.url) {
      next.quotedTweet = {
        tweetId: mainDetail.quotedTweet.tweetId,
        username: mainDetail.quotedTweet.username,
        url: mainDetail.quotedTweet.url
      };
    }

    return next;
  }

  async clickShowMoreInTweet(page, expectedUsername, expectedTweetId) {
    const expectedHandle = normalizeUsername(expectedUsername);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const targets = await page.evaluate(({ expectedHandle, expectedTweetId }) => {
        const normalizeHandle = (value) => String(value || "").replace(/^@/, "").trim().toLowerCase();
        const parseStatusHref = (href) => {
          if (!href) return null;
          try {
            const url = new URL(href, location.origin);
            const path = decodeURIComponent(url.pathname);
            const match = path.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
            if (!match) return null;
            return { handle: normalizeHandle(match[1]), id: match[2] };
          } catch {
            const match = String(href).match(/\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
            return match ? { handle: normalizeHandle(match[1]), id: match[2] } : null;
          }
        };
        const statusLinksOf = (root) =>
          Array.from(root.querySelectorAll('a[href*="/status/"]'))
            .map((link) => ({ parsed: parseStatusHref(link.href || link.getAttribute("href")), link }))
            .filter((item) => item.parsed);
        const articles = Array.from(document.querySelectorAll("article"));
        const mainArticle =
          articles.find((article) =>
            statusLinksOf(article).some((item) => item.parsed.id === expectedTweetId && (!expectedHandle || item.parsed.handle === expectedHandle))
          ) || articles[0];
        if (!mainArticle) return [];

        const showMoreNodes = Array.from(mainArticle.querySelectorAll("span, div[role='button'], a, button"))
          .filter((node) => /^(显示更多|Show more)$/i.test(String(node.textContent || "").trim()))
          .map((node) => node.closest("button,[role='button'],a") || node)
          .filter(Boolean);

        return showMoreNodes
          .map((node) => {
            node.scrollIntoView?.({ block: "center", inline: "center" });
            const rect = node.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return null;
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              text: String(node.textContent || "").trim()
            };
          })
          .filter(Boolean);
      }, { expectedHandle, expectedTweetId }).catch(() => []);

      if (!targets.length) return false;

      for (const target of targets) {
        await page.mouse.click(target.x, target.y).catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    return true;
  }

  async scrapeTweetDetail(page, tweetUrl, expectedUsername, expectedTweetId) {
    const expectedHandle = normalizeUsername(expectedUsername);
    await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("article", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);

    await this.clickShowMoreInTweet(page, expectedHandle, expectedTweetId);
    await page.waitForTimeout(1200);

    return page.evaluate(({ expectedHandle, expectedTweetId }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cleanText = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .split(/\n+/)
          .map((line) => line.replace(/[ \t]+/g, " ").trim())
          .filter(Boolean)
          .join("\n");
      const normalizeHandle = (value) => String(value || "").replace(/^@/, "").trim().toLowerCase();
      const canonicalImage = (src) => {
        if (!src || /profile_images|emoji/i.test(src)) return "";
        try {
          const url = new URL(src, location.origin);
          if (!/twimg\.com$/i.test(url.hostname)) return "";
          if (!/\/media\/|\/card_img\//i.test(url.pathname)) return "";
          if (/\/media\//i.test(url.pathname)) url.searchParams.set("name", "large");
          return url.toString();
        } catch {
          return "";
        }
      };

      const parseStatusHref = (href) => {
        if (!href) return null;
        try {
          const url = new URL(href, location.origin);
          const path = decodeURIComponent(url.pathname);
          const match = path.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
          if (!match) return null;
          return { handle: normalizeHandle(match[1]), id: match[2], href: url.href };
        } catch {
          const match = String(href).match(/\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
          return match ? { handle: normalizeHandle(match[1]), id: match[2], href } : null;
        }
      };

      const statusLinksOf = (root) =>
        Array.from(root.querySelectorAll('a[href*="/status/"]'))
          .map((link) => {
            const parsed = parseStatusHref(link.href || link.getAttribute("href"));
            return parsed ? { ...parsed, link } : null;
          })
          .filter(Boolean);

      const readAuthorHandle = (article) => {
        const userNameBlocks = Array.from(article.querySelectorAll('[data-testid="User-Name"]'));
        const firstBlockText = normalize(userNameBlocks[0]?.innerText || userNameBlocks[0]?.textContent || "");
        const handles = Array.from(firstBlockText.matchAll(/@([A-Za-z0-9_]{1,15})/g)).map((m) => normalizeHandle(m[1]));
        return handles[0] || "";
      };

      const articles = Array.from(document.querySelectorAll("article"));
      const mainArticle =
        articles.find((article) =>
          statusLinksOf(article).some((item) => item.id === expectedTweetId && (!expectedHandle || item.handle === expectedHandle))
        ) || articles[0];

      if (!mainArticle) return {};

      const textNodes = Array.from(mainArticle.querySelectorAll('[data-testid="tweetText"]'));
      const mainTextNode = textNodes[0] || null;
      const mainText = cleanText(mainTextNode?.innerText || mainTextNode?.textContent || "");
      const links = statusLinksOf(mainArticle);
      const primaryStatus = links.find((item) => item.id === expectedTweetId) || links[0];
      const publishedAt =
        primaryStatus?.link?.querySelector("time[datetime]")?.getAttribute("datetime") ||
        mainArticle.querySelector("time[datetime]")?.getAttribute("datetime") ||
        "";
      const rawArticleText = normalize(mainArticle.innerText || mainArticle.textContent || "");
      const editedAt = /(?:last\s*edited|edited|已编辑|已編輯|编辑|編輯)/i.test(rawArticleText)
        ? Array.from(mainArticle.querySelectorAll("time[datetime]"))
            .map((node) => node.getAttribute("datetime") || "")
            .find((value) => value && value !== publishedAt) || "页面显示已编辑（未识别具体时间）"
        : "";

      const collectImages = (root, ownerTweetId) => [
        ...new Set(
          Array.from(root?.querySelectorAll?.("img") || [])
            .map((img) => {
              const owner = parseStatusHref(img.closest('a[href*="/status/"]')?.href || "");
              if (ownerTweetId && owner?.id && owner.id !== ownerTweetId) return "";
              return canonicalImage(img.currentSrc || img.src || "");
            })
            .filter(Boolean)
        )
      ].slice(0, 8);

      const quotedStatus = links.find((item) => item.id && item.id !== expectedTweetId);
      let quotedTweet = null;
      if (quotedStatus) {
        let quoteRoot = null;
        for (let node = quotedStatus.link; node && node !== mainArticle; node = node.parentElement) {
          if (node.querySelectorAll && Array.from(node.querySelectorAll('[data-testid="tweetText"]')).some((item) => item !== mainTextNode)) {
            quoteRoot = node;
            break;
          }
        }
        const quotedTextNode =
          (quoteRoot
            ? Array.from(quoteRoot.querySelectorAll('[data-testid="tweetText"]')).find((item) => item !== mainTextNode)
            : textNodes.find((item) => item !== mainTextNode)) || null;
        quotedTweet = {
          tweetId: quotedStatus.id,
          username: quotedStatus.handle,
          matchedAuthor: quoteRoot ? readAuthorHandle(quoteRoot) || quotedStatus.handle : quotedStatus.handle,
          text: cleanText(quotedTextNode?.innerText || quotedTextNode?.textContent || ""),
          url: `https://x.com/${quotedStatus.handle}/status/${quotedStatus.id}`,
          imageUrls: collectImages(quoteRoot || mainArticle, quotedStatus.id)
        };
      }

      return {
        tweetId: expectedTweetId,
        username: expectedHandle || readAuthorHandle(mainArticle),
        matchedAuthor: readAuthorHandle(mainArticle) || expectedHandle,
        authorVerified: true,
        text: mainText,
        url: `https://x.com/${expectedHandle}/status/${expectedTweetId}`,
        tweetCreatedAt: publishedAt,
        tweetEditedAt: editedAt,
        imageUrls: collectImages(mainArticle, expectedTweetId),
        quotedTweet
      };
    }, { expectedHandle, expectedTweetId });
  }

  async syncLatestFromXApi(config, options = {}) {
    const query = buildQuery(config.usernames, config.options);
    const params = new URLSearchParams({
      query,
      max_results: "10",
      "tweet.fields": "created_at,author_id",
      expansions: "author_id",
      "user.fields": "username,name"
    });

    this.log("info", "同步最近推文", { provider: "x-api", query });
    const res = await this.xFetch(`${RECENT_SEARCH_URL}?${params.toString()}`, config);
    const payload = await res.json();
    const tweets = payload.data || [];

    if (!tweets.length && !options.silentIfEmpty) {
      this.log("warn", "最近搜索没有返回新内容");
    }

    let pushed = 0;
    for (const tweet of tweets.reverse()) {
      const user = (payload.includes?.users || []).find((item) => item.id === tweet.author_id);
      if (!user) continue;
      const didPush = await this.handleXTweetPayload({ data: tweet, includes: { users: [user] } }, config);
      if (didPush) pushed += 1;
    }
    this.log("success", "最近推文同步完成", { provider: "x-api", pushed });
    return { pushed };
  }

  async handleXTweetPayload(payload, config) {
    const tweet = payload.data;
    if (!tweet?.id) return false;
    const user = (payload.includes?.users || []).find((item) => item.id === tweet.author_id);
    if (!user?.username) {
      this.log("warn", "收到推文但无法匹配作者", { tweetId: tweet.id });
      return false;
    }
    return this.handleNormalizedTweet(
      {
        tweetId: tweet.id,
        username: user.username,
        matchedAuthor: user.username,
        authorVerified: true,
        name: user.name,
        text: tweet.text || "",
        tweetCreatedAt: tweet.created_at || "",
        tweetEditedAt: "",
        sourceChannel: "posts",
        sourceLabel: "帖子",
        url: formatTweetUrl(user.username, tweet.id)
      },
      config
    );
  }

  async handleNormalizedTweet(tweet, config) {
    if (!tweet?.tweetId) return false;
    if (this.seenTweetIds.has(tweet.tweetId)) return false;

    const configuredUsers = new Set((config.usernames || []).map(normalizeUsername).filter(Boolean));
    const tweetUser = normalizeUsername(tweet.username);
    const matchedAuthor = normalizeUsername(tweet.matchedAuthor || tweet.username);
    const authorVerified =
      tweet.authorVerified === true && configuredUsers.has(tweetUser) && matchedAuthor === tweetUser;

    if (!authorVerified) {
      this.log("warn", "跳过用户名校验失败的页面内容", {
        configured: Array.from(configuredUsers),
        tweetUsername: tweet.username,
        matchedAuthor: tweet.matchedAuthor || "",
        tweetId: tweet.tweetId
      });
      return false;
    }

    this.markTweetsSeen([tweet.tweetId]);
    const aShareCodes = extractAshareCodesFromTexts([
      { label: "正文", text: tweet.text || "" },
      { label: "引用原文", text: tweet.quotedTweet?.text || "" }
    ]);

    const record = {
      id: `${Date.now()}-${tweet.tweetId}`,
      tweetId: tweet.tweetId,
      username: tweetUser,
      matchedAuthor,
      authorVerified,
      name: tweet.name,
      text: tweet.text || "",
      imageUrls: uniqueNonEmpty(tweet.imageUrls || [], 8),
      quotedTweet: tweet.quotedTweet || null,
      url: tweet.url || formatTweetUrl(tweetUser, tweet.tweetId),
      tweetCreatedAt: tweet.tweetCreatedAt || "",
      tweetEditedAt: tweet.tweetEditedAt || "",
      sourceChannel: tweet.sourceChannel || "posts",
      sourceLabel: tweet.sourceLabel || browserChannelLabel(tweet.sourceChannel || "posts"),
      createdAt: nowIso(),
      status: "pending",
      translationStatus: config.options.translationEnabled === false ? "disabled" : "pending",
      aShareCodes,
      aShareAlertStatus: aShareCodes.length ? "pending" : "none",
      provider: config.provider
    };

    this.log("info", `捕获 @${tweet.username} 新推文`, {
      provider: config.provider,
      sourceChannel: record?.sourceChannel,
      tweetId: tweet.tweetId,
      preview: safeSnippet(tweet.text)
    });

    try {
      await this.sendDingTalk(record, config);
      if (record.aShareCodes.length) {
        try {
          await wait(500);
          await this.sendDingTalkAshareAlert(record, config);
          record.aShareAlertStatus = "sent";
          this.log("success", "A股代码额外提醒发送成功", {
            username: tweet.username,
            tweetId: tweet.tweetId,
            codes: record.aShareCodes.map((item) => item.display)
          });
        } catch (aShareAlertErr) {
          record.aShareAlertStatus = "failed";
          record.aShareAlertError = aShareAlertErr.message;
          this.log("error", "A股代码额外提醒发送失败", {
            error: aShareAlertErr.message,
            tweetId: tweet.tweetId,
            codes: record.aShareCodes.map((item) => item.display)
          });
        }
      }
      if (config.options.translationEnabled !== false) {
        try {
          await wait(700);
          const translation = await translateToChinese(record.text);
          if (!translation.text) throw new Error("翻译结果为空");
          record.translatedText = translation.text;
          record.translationSourceLang = translation.sourceLang || "";
          await this.sendDingTalkTranslation(record, config);
          record.translationStatus = "sent";
          this.log("success", "中文翻译推送成功", {
            username: tweet.username,
            tweetId: tweet.tweetId,
            sourceLang: record.translationSourceLang || "auto"
          });
        } catch (translationErr) {
          record.translationStatus = "failed";
          record.translationError = translationErr.message;
          this.log("error", "中文翻译推送失败", { error: translationErr.message, tweetId: tweet.tweetId });
        }
      }
      record.status = "sent";
      this.state.dingtalkOk = true;
      this.state.lastPushAt = record.createdAt;
      this.log("success", "钉钉推送成功", { username: tweet.username, tweetId: tweet.tweetId });
    } catch (err) {
      record.status = "failed";
      record.error = err.message;
      this.state.dingtalkOk = false;
      this.state.lastError = err.message;
      this.log("error", "钉钉推送失败", { error: err.message, tweetId: tweet.tweetId });
    }

    this.records.unshift(record);
    this.records = this.records.slice(0, 200);
    writeRecords(this.records);
    this.resetTodayCounter();
    this.emitEvent("record", record);
    this.updateState({ ...this.state });
    return record.status === "sent";
  }

  async sendDingTalkMarkdown(title, text, config) {
    const webhook = buildDingTalkSignedWebhook(config.dingTalkWebhook, config.dingTalkSecret);
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title, text }
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errcode !== 0) {
      throw new Error(`DingTalk ${res.status}: ${JSON.stringify(json).slice(0, 800)}`);
    }
    return json;
  }

  async sendDingTalk(record, config) {
    const sourceLabel = record.sourceLabel || browserChannelLabel(record.sourceChannel);
    const title = `推特监控：@${record.username} ${sourceLabel}（原文）`;
    const includeQuotedTweet = config.options.includeQuotedTweet !== false;
    const quotedTweet = includeQuotedTweet ? record.quotedTweet : null;
    const quotedLines = quotedTweet?.text
      ? [
          "",
          "#### 原推文全文",
          quotedTweet.username ? `> @${quotedTweet.username}` : "",
          markdownQuote(quotedTweet.text),
          ...imageMarkdownLines(quotedTweet.imageUrls || [], "原推文图片"),
          quotedTweet.url ? `[查看原推文](${quotedTweet.url})` : ""
        ].filter(Boolean)
      : [];
    const text = [
      `### ${title}`,
      "",
      markdownQuote(record.text),
      ...imageMarkdownLines(record.imageUrls || [], "图片"),
      ...quotedLines,
      "",
      `- 博主：@${record.username}`,
      sourceLabel ? `- 发现频道：${sourceLabel}` : "",
      `- 作者校验：${record.authorVerified ? "已通过" : "未校验"}${record.matchedAuthor ? `（页面作者 @${record.matchedAuthor}）` : ""}`,
      `- 原文发布时间：${record.tweetCreatedAt || "未识别"}`,
      `- 最后编辑时间：${record.tweetEditedAt || "未识别/无编辑标记"}`,
      `- 捕获时间：${record.createdAt}`,
      record.provider ? `- 数据源：${record.provider}` : "",
      "",
      `[查看原文](${record.url})`
    ]
      .filter(Boolean)
      .join("\n");

    return this.sendDingTalkMarkdown(title, text, config);
  }

  async sendDingTalkAshareAlert(record, config) {
    const sourceLabel = record.sourceLabel || browserChannelLabel(record.sourceChannel);
    const codeLines = (record.aShareCodes || []).map((item) => {
      const sources = item.sources?.length ? `（${item.sources.join("、")}）` : "";
      const matched = item.matchedTexts?.length ? `；原文命中：${item.matchedTexts.slice(0, 3).join(" / ")}` : "";
      return `- **${item.display || formatAshareCode(item.code, item.market)}**${sources}${matched}`;
    });
    const title = `A股代码提醒：@${record.username} ${sourceLabel}`;
    const text = [
      `### ${title}`,
      "",
      "监控内容命中 A 股股票代码，请单独关注：",
      "",
      ...codeLines,
      "",
      `- 博主：@${record.username}`,
      sourceLabel ? `- 发现频道：${sourceLabel}` : "",
      `- 原文发布时间：${record.tweetCreatedAt || "未识别"}`,
      `- 捕获时间：${record.createdAt}`,
      "",
      "[查看原文](" + record.url + ")"
    ]
      .filter(Boolean)
      .join("\n");

    return this.sendDingTalkMarkdown(title, text, config);
  }

  async sendDingTalkTranslation(record, config) {
    const sourceLabel = record.sourceLabel || browserChannelLabel(record.sourceChannel);
    const title = `推特监控：@${record.username} ${sourceLabel}中文翻译`;
    const text = [
      `### ${title}`,
      "",
      markdownQuote(record.translatedText),
      "",
      `- 博主：@${record.username}`,
      sourceLabel ? `- 发现频道：${sourceLabel}` : "",
      record.translationSourceLang ? `- 识别语言：${record.translationSourceLang}` : "",
      `- 作者校验：${record.authorVerified ? "已通过" : "未校验"}${record.matchedAuthor ? `（页面作者 @${record.matchedAuthor}）` : ""}`,
      `- 原文发布时间：${record.tweetCreatedAt || "未识别"}`,
      `- 最后编辑时间：${record.tweetEditedAt || "未识别/无编辑标记"}`,
      `- 捕获时间：${record.createdAt}`,
      "- 说明：自动机器翻译，仅供快速阅读",
      "",
      `[查看原文](${record.url})`
    ]
      .filter(Boolean)
      .join("\n");

    return this.sendDingTalkMarkdown(title, text, config);
  }

  async testDingTalk(webhook, secret) {
    const config = readRuntimeConfig();
    const targetWebhook = webhook || config.dingTalkWebhook;
    if (!targetWebhook) throw new Error("缺少钉钉 Webhook");
    const testConfig = {
      ...config,
      dingTalkWebhook: targetWebhook,
      dingTalkSecret: secret || config.dingTalkSecret
    };
    const record = {
      username: "monitor",
      matchedAuthor: "monitor",
      authorVerified: true,
      text: "这是一条来自推文监控台的钉钉测试消息。若收到，说明机器人 Webhook 可用。",
      url: "https://x.com/",
      tweetCreatedAt: "",
      tweetEditedAt: "",
      sourceChannel: "test",
      sourceLabel: "测试",
      createdAt: nowIso(),
      provider: config.provider
    };
    await this.sendDingTalk(record, testConfig);
    this.updateState({ dingtalkOk: true });
    this.log("success", "钉钉测试消息发送成功");
    return { ok: true };
  }
}

export const monitorService = new MonitorService();
