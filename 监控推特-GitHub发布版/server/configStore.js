import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const RECORDS_PATH = path.join(DATA_DIR, "records.json");
export const SEEN_TWEETS_PATH = path.join(DATA_DIR, "seen-tweets.json");

const DEFAULT_CONFIG = {
  provider: "browser",
  xBearerToken: "",
  dingTalkWebhook: "",
  dingTalkSecret: "",
  usernames: [],
  options: {
    filterRetweets: true,
    originalOnly: true,
    autoReconnect: true,
    mode: "poll",
    pollIntervalSec: 60,
    baselineOnlyOnStart: true,
    browserHeadless: false,
    translationEnabled: true,
    includeQuotedTweet: true,
    monitorChannels: {
      posts: true,
      replies: true,
      subscriptions: true
    }
  }
};

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function normalizeMonitorChannels(input = {}) {
  return {
    posts: input.posts !== false,
    replies: input.replies !== false,
    subscriptions: input.subscriptions !== false
  };
}

export function normalizeUsernames(input) {
  const raw = Array.isArray(input) ? input.join(",") : String(input || "");
  return [
    ...new Set(
      raw
        .split(/[\s,，;；\n\r]+/)
        .map((item) => {
          const trimmed = item.trim();
          const urlMatch = trimmed.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i);
          return (urlMatch ? urlMatch[1] : trimmed)
            .replace(/^@/, "")
            .replace(/^\/+/, "")
            .trim();
        })
        .filter((item) => /^[A-Za-z0-9_]{1,15}$/.test(item))
        .filter(Boolean)
    )
  ];
}

function normalizeProvider(provider) {
  return provider === "x-api" ? "x-api" : "browser";
}

function mergeConfig(fileConfig = {}) {
  const envUsers = normalizeUsernames(process.env.TWITTER_USERS || "");
  const fileUsers = normalizeUsernames(fileConfig.usernames || []);
  const provider = normalizeProvider(fileConfig.provider || process.env.TWITTER_PROVIDER);

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    provider,
    xBearerToken: fileConfig.xBearerToken || process.env.X_BEARER_TOKEN || "",
    dingTalkWebhook: fileConfig.dingTalkWebhook || process.env.DINGTALK_WEBHOOK || "",
    dingTalkSecret: fileConfig.dingTalkSecret || process.env.DINGTALK_SECRET || "",
    usernames: fileUsers.length ? fileUsers : envUsers,
    options: {
      ...DEFAULT_CONFIG.options,
      ...(fileConfig.options || {}),
      monitorChannels: normalizeMonitorChannels(fileConfig.options?.monitorChannels || {}),
      mode:
        provider === "browser"
          ? "poll"
          : fileConfig.options?.mode === "stream"
            ? "stream"
            : "poll"
    }
  };
}

export function readRuntimeConfig() {
  const fileConfig = readJson(CONFIG_PATH, {});
  return mergeConfig(fileConfig);
}

export function readPublicConfig() {
  const config = readRuntimeConfig();
  return {
    provider: config.provider,
    dingTalkWebhook: config.dingTalkWebhook,
    dingTalkSecret: config.dingTalkSecret,
    usernames: config.usernames,
    options: config.options,
    hasXBearerToken: Boolean(config.xBearerToken),
    hasDingTalkWebhook: Boolean(config.dingTalkWebhook),
    hasDingTalkSecret: Boolean(config.dingTalkSecret),
    xBearerTokenSource: config.xBearerToken ? "已配置" : "未配置",
    dingTalkWebhookSource: config.dingTalkWebhook ? "已配置" : "未配置",
    dingTalkSecretSource: config.dingTalkSecret ? "已配置" : "未配置"
  };
}

export function saveConfig(payload = {}) {
  const existingFile = readJson(CONFIG_PATH, {});
  const existing = mergeConfig(existingFile);
  const provider = normalizeProvider(payload.provider || existing.provider);

  const next = {
    ...existing,
    provider,
    usernames:
      payload.usernames !== undefined
        ? normalizeUsernames(payload.usernames)
        : existing.usernames,
    options: {
      ...existing.options,
      ...(payload.options || {})
    }
  };

  if (typeof payload.xBearerToken === "string" && payload.xBearerToken.trim()) {
    next.xBearerToken = payload.xBearerToken.trim();
  }

  if (typeof payload.dingTalkWebhook === "string" && payload.dingTalkWebhook.trim()) {
    next.dingTalkWebhook = payload.dingTalkWebhook.trim();
  }

  if (typeof payload.dingTalkSecret === "string" && payload.dingTalkSecret.trim()) {
    next.dingTalkSecret = payload.dingTalkSecret.trim();
  }

  next.options.pollIntervalSec = Math.max(
    20,
    Number(next.options.pollIntervalSec || DEFAULT_CONFIG.options.pollIntervalSec)
  );
  next.options.mode = next.provider === "browser" ? "poll" : next.options.mode === "stream" ? "stream" : "poll";
  next.options.baselineOnlyOnStart = next.options.baselineOnlyOnStart !== false;
  next.options.browserHeadless = next.options.browserHeadless === true;
  next.options.translationEnabled = next.options.translationEnabled !== false;
  next.options.includeQuotedTweet = next.options.includeQuotedTweet !== false;
  next.options.monitorChannels = normalizeMonitorChannels(next.options.monitorChannels || {});

  writeJson(CONFIG_PATH, next);
  return readPublicConfig();
}

export function readRecords() {
  const records = readJson(RECORDS_PATH, []);
  return Array.isArray(records) ? records : [];
}

export function writeRecords(records) {
  writeJson(RECORDS_PATH, records.slice(0, 200));
}

export function readSeenTweetIds() {
  const items = readJson(SEEN_TWEETS_PATH, []);
  if (!Array.isArray(items)) return [];
  return [
    ...new Set(
      items
        .map((item) => (typeof item === "string" ? item : item?.tweetId))
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  ];
}

export function writeSeenTweetIds(tweetIds) {
  const ids = [
    ...new Set(
      (Array.isArray(tweetIds) ? tweetIds : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  ].slice(-20000);
  writeJson(SEEN_TWEETS_PATH, ids);
}
