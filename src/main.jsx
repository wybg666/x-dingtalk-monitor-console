import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const defaultConfig = {
  provider: "browser",
  usernames: [],
  hasXBearerToken: false,
  hasDingTalkWebhook: false,
  hasDingTalkSecret: false,
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

const browserChannelLabels = {
  posts: "帖子",
  replies: "回复",
  subscriptions: "订阅"
};

function normalizeMonitorChannels(channels = {}) {
  return {
    posts: channels.posts !== false,
    replies: channels.replies !== false,
    subscriptions: channels.subscriptions !== false
  };
}

const defaultState = {
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

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function cx(...names) {
  return names.filter(Boolean).join(" ");
}

function parseUsers(usernamesText) {
  return [
    ...new Set(
      usernamesText
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

function buildRulePreview(provider, usernamesText, options) {
  const users = parseUsers(usernamesText);
  if (!users.length) return "填写博主后自动生成监控规则";
  if (provider === "browser") {
    const channels = normalizeMonitorChannels(options.monitorChannels);
    const channelText = Object.entries(channels)
      .filter(([, enabled]) => enabled)
      .map(([key]) => browserChannelLabels[key] || key)
      .join("、");
    return `本地浏览器多频道轮询：${users.map((u) => `@${u}`).join("、")} / ${channelText || "未选择频道"}`;
  }

  const fromPart = users.length === 1 ? `from:${users[0]}` : `(${users.map((user) => `from:${user}`).join(" OR ")})`;
  const filters = [];
  if (options.filterRetweets) filters.push("-is:retweet");
  if (options.originalOnly) filters.push("-is:reply", "-is:quote");
  return [fromPart, ...filters].join(" ");
}

function StatCard({ label, value, hint, tone = "cyan" }) {
  return (
    <section className={cx("stat-card", `tone-${tone}`)}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-hint">{hint}</div>
    </section>
  );
}

function Toggle({ checked, label, description, onChange }) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

function StatusPill({ state }) {
  const tone = state.running ? (state.connected ? "online" : "warning") : "offline";
  const text = state.running ? (state.connected ? "运行中" : "重连中") : "已停止";
  return <span className={cx("status-pill", tone)}>{text}</span>;
}

function App() {
  const [config, setConfig] = useState(defaultConfig);
  const [state, setState] = useState(defaultState);
  const [logs, setLogs] = useState([]);
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState({
    provider: "browser",
    xBearerToken: "",
    dingTalkWebhook: "",
    dingTalkSecret: "",
    usernamesText: "",
    filterRetweets: true,
    originalOnly: true,
    autoReconnect: true,
    mode: "poll",
    pollIntervalSec: 60,
    baselineOnlyOnStart: true,
    browserHeadless: false,
    translationEnabled: true,
    includeQuotedTweet: true,
    monitorPosts: true,
    monitorReplies: true,
    monitorSubscriptions: true
  });
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    (async () => {
      const cfg = await api("/api/config");
      setConfig(cfg);
      setForm((prev) => ({
        ...prev,
        provider: cfg.provider || "browser",
        dingTalkWebhook: cfg.dingTalkWebhook || "",
        dingTalkSecret: cfg.dingTalkSecret || "",
        usernamesText: cfg.usernames.join("\n"),
        filterRetweets: cfg.options.filterRetweets,
        originalOnly: cfg.options.originalOnly,
        autoReconnect: cfg.options.autoReconnect,
        mode: cfg.options.mode,
        pollIntervalSec: cfg.options.pollIntervalSec,
        baselineOnlyOnStart: cfg.options.baselineOnlyOnStart !== false,
        browserHeadless: cfg.options.browserHeadless === true,
        translationEnabled: cfg.options.translationEnabled !== false,
        includeQuotedTweet: cfg.options.includeQuotedTweet !== false,
        monitorPosts: normalizeMonitorChannels(cfg.options.monitorChannels).posts,
        monitorReplies: normalizeMonitorChannels(cfg.options.monitorChannels).replies,
        monitorSubscriptions: normalizeMonitorChannels(cfg.options.monitorChannels).subscriptions
      }));
      const snapshot = await api("/api/state");
      setState(snapshot.state);
      setLogs(snapshot.logs || []);
      setRecords(snapshot.records || []);
    })().catch((err) => showToast(err.message));
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "heartbeat") return;
      if (data.type === "snapshot") {
        setState(data.payload.state);
        setLogs(data.payload.logs || []);
        setRecords(data.payload.records || []);
        return;
      }
      if (data.type === "state") setState(data.payload);
      if (data.type === "log") setLogs((items) => [data.payload, ...items].slice(0, 300));
      if (data.type === "record") setRecords((items) => [data.payload, ...items].slice(0, 200));
      if (data.type === "logs-cleared") setLogs([]);
    };
    source.onerror = () => {
      setLogs((items) =>
        [
          {
            id: Date.now(),
            at: new Date().toISOString(),
            level: "warn",
            message: "实时日志连接中断，浏览器会自动重连",
            meta: {}
          },
          ...items
        ].slice(0, 300)
      );
    };
    return () => source.close();
  }, []);

  const missingItems = useMemo(() => {
    const items = [];
    if (form.provider === "x-api" && !config.hasXBearerToken && !form.xBearerToken) items.push("X Bearer Token");
    if (!config.hasDingTalkWebhook && !form.dingTalkWebhook) items.push("钉钉 Webhook");
    if (!form.usernamesText.trim()) items.push("监控博主");
    if (form.provider === "browser" && !form.monitorPosts && !form.monitorReplies && !form.monitorSubscriptions) items.push("至少一个监控频道");
    return items;
  }, [config, form]);

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(""), 3600);
  }

  function updateForm(patch) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  async function runAction(name, fn, successText) {
    try {
      setBusy(name);
      await fn();
      if (successText) showToast(successText);
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy("");
    }
  }

  async function saveConfig() {
    const provider = form.provider;
    const next = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        provider,
        xBearerToken: form.xBearerToken,
        dingTalkWebhook: form.dingTalkWebhook,
        dingTalkSecret: form.dingTalkSecret,
        usernames: form.usernamesText,
        options: {
          filterRetweets: form.filterRetweets,
          originalOnly: form.originalOnly,
          autoReconnect: form.autoReconnect,
          mode: provider === "browser" ? "poll" : form.mode,
          pollIntervalSec: Number(form.pollIntervalSec || 60),
          baselineOnlyOnStart: form.baselineOnlyOnStart,
          browserHeadless: form.browserHeadless,
          translationEnabled: form.translationEnabled,
          includeQuotedTweet: form.includeQuotedTweet,
          monitorChannels: {
            posts: form.monitorPosts,
            replies: form.monitorReplies,
            subscriptions: form.monitorSubscriptions
          }
        }
      })
    });
    setConfig(next);
    setForm((prev) => ({
      ...prev,
      provider: next.provider,
      xBearerToken: "",
      dingTalkWebhook: next.dingTalkWebhook || prev.dingTalkWebhook,
      dingTalkSecret: next.dingTalkSecret || prev.dingTalkSecret,
      usernamesText: next.usernames.join("\n"),
      mode: next.options.mode,
      translationEnabled: next.options.translationEnabled !== false,
      includeQuotedTweet: next.options.includeQuotedTweet !== false,
      monitorPosts: normalizeMonitorChannels(next.options.monitorChannels).posts,
      monitorReplies: normalizeMonitorChannels(next.options.monitorChannels).replies,
      monitorSubscriptions: normalizeMonitorChannels(next.options.monitorChannels).subscriptions
    }));
    return next;
  }

  async function startMonitor() {
    await saveConfig();
    if (missingItems.length) {
      throw new Error(`启动前还需要：${missingItems.join("、")}`);
    }
    const next = await api("/api/start", { method: "POST" });
    setState(next);
  }

  async function syncLatestWithSave() {
    await saveConfig();
    return api("/api/sync-latest", { method: "POST" });
  }

  const currentRule =
    state.currentRule ||
    buildRulePreview(form.provider, form.usernamesText, {
      filterRetweets: form.filterRetweets,
      originalOnly: form.originalOnly,
      monitorChannels: {
        posts: form.monitorPosts,
        replies: form.monitorReplies,
        subscriptions: form.monitorSubscriptions
      }
    });

  const providerName = form.provider === "browser" ? "浏览器免费模式" : "官方 X API";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">推</span>
          <div>
            <strong>推文监控台</strong>
            <small>DingTalk Relay</small>
          </div>
        </div>
        <nav>
          <a className="active" href="#config">监控配置</a>
          <a href="#logs">实时日志</a>
          <a href="#records">推送记录</a>
        </nav>
        <div className="sidebar-card">
          <span>当前规则</span>
          <p>{currentRule}</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>推文监控台</h1>
            <p>免费模式用本地浏览器轮询博主主页；发现新推文后推送到钉钉群。</p>
          </div>
          <StatusPill state={state} />
        </header>

        <section className="stats-grid">
          <StatCard
            label="运行状态"
            value={state.running ? (state.connected ? "已连接" : "等待重连") : "未启动"}
            hint={state.startedAt ? `启动：${formatTime(state.startedAt)}` : "点击启动监控开始"}
            tone={state.running ? "cyan" : "slate"}
          />
          <StatCard label="数据源" value={state.provider === "x-api" ? "官方 API" : "浏览器"} hint={providerName} tone="blue" />
          <StatCard label="今日推送" value={state.todayPush || 0} hint={`累计 ${state.totalPush || records.length} 条`} tone="green" />
          <StatCard
            label="钉钉状态"
            value={state.dingtalkOk ? "可用" : config.hasDingTalkWebhook ? "待验证" : "未配置"}
            hint={state.lastPushAt ? `上次：${formatTime(state.lastPushAt)}` : "可先测试机器人"}
            tone={state.dingtalkOk ? "green" : "amber"}
          />
        </section>

        <section className="workspace-grid">
          <div className="panel config-panel" id="config">
            <div className="panel-heading">
              <div>
                <h2>监控配置</h2>
                <p>默认不使用任何付费 API。配置保存到本机 <code>data/config.json</code>。</p>
              </div>
              <button className="ghost-button" onClick={() => runAction("save", saveConfig, "配置已保存")} disabled={busy === "save"}>
                {busy === "save" ? "保存中..." : "保存配置"}
              </button>
            </div>

            <div className="mode-row">
              <label className="field compact">
                <span>数据源</span>
                <select value={form.provider} onChange={(event) => updateForm({ provider: event.target.value, mode: event.target.value === "browser" ? "poll" : form.mode })}>
                  <option value="browser">浏览器免费模式</option>
                  <option value="x-api">官方 X API（可能收费）</option>
                </select>
              </label>
              <label className="field compact">
                <span>轮询间隔（秒）</span>
                <input type="number" min="20" value={form.pollIntervalSec} onChange={(event) => updateForm({ pollIntervalSec: event.target.value })} />
              </label>
            </div>

            {form.provider === "x-api" && (
              <label className="field">
                <span>X Bearer Token</span>
                <input
                  type="password"
                  value={form.xBearerToken}
                  placeholder={config.hasXBearerToken ? "已保存，留空不变" : "粘贴 X API Bearer Token"}
                  onChange={(event) => updateForm({ xBearerToken: event.target.value })}
                />
              </label>
            )}

            <label className="field">
              <span>钉钉机器人 Webhook</span>
              <input
                type="text"
                value={form.dingTalkWebhook}
                placeholder={config.hasDingTalkWebhook ? "已保存，留空不变" : "粘贴钉钉机器人 Webhook"}
                onChange={(event) => updateForm({ dingTalkWebhook: event.target.value })}
              />
            </label>

            <label className="field">
              <span>钉钉加签 Secret（可选）</span>
              <input
                type="text"
                value={form.dingTalkSecret}
                placeholder={config.hasDingTalkSecret ? "已保存，留空不变" : "机器人开启“加签”时，粘贴 SEC 开头密钥"}
                onChange={(event) => updateForm({ dingTalkSecret: event.target.value })}
              />
            </label>

            <label className="field">
              <span>监控博主用户名</span>
              <textarea value={form.usernamesText} placeholder={"每行一个，例如：\nelonmusk\nOpenAI"} onChange={(event) => updateForm({ usernamesText: event.target.value })} />
            </label>

            {form.provider === "x-api" && (
              <label className="field compact">
                <span>官方 API 运行模式</span>
                <select value={form.mode} onChange={(event) => updateForm({ mode: event.target.value })}>
                  <option value="poll">轮询 Recent Search</option>
                  <option value="stream">实时流 Stream</option>
                </select>
              </label>
            )}

            <div className="toggles">
              <Toggle checked={form.monitorPosts} label="监控帖子" description="扫描个人主页默认“帖子”频道" onChange={(checked) => updateForm({ monitorPosts: checked })} />
              <Toggle checked={form.monitorReplies} label="监控回复" description="扫描 /with_replies 回复频道" onChange={(checked) => updateForm({ monitorReplies: checked })} />
              <Toggle checked={form.monitorSubscriptions} label="监控订阅" description="从页面动态查找“订阅”频道入口" onChange={(checked) => updateForm({ monitorSubscriptions: checked })} />
              <Toggle checked={form.filterRetweets} label="过滤转推" description="浏览器模式下按页面文本尽量识别" onChange={(checked) => updateForm({ filterRetweets: checked })} />
              <Toggle checked={form.originalOnly} label="帖子页只推原创" description="只作用于“帖子”频道；回复/订阅频道仍会独立扫描" onChange={(checked) => updateForm({ originalOnly: checked })} />
              <Toggle checked={form.includeQuotedTweet} label="显示原推文全文" description="引用/转推里带原推文时，进原推文详情页抓全文并一起推送" onChange={(checked) => updateForm({ includeQuotedTweet: checked })} />
              <Toggle checked={form.baselineOnlyOnStart} label="首次只建基线" description="启动时不推送历史推文，避免刷屏" onChange={(checked) => updateForm({ baselineOnlyOnStart: checked })} />
              <Toggle checked={form.translationEnabled} label="自动中文翻译" description="每条先发原文，再发一条中文翻译" onChange={(checked) => updateForm({ translationEnabled: checked })} />
            </div>

            {form.provider === "browser" && (
              <div className="notice">浏览器免费模式不需要 X API Token；首次使用请点“打开/登录 X”，在弹出的本地浏览器里登录一次。</div>
            )}
            {missingItems.length > 0 && <div className="notice">启动前还需要：{missingItems.join("、")}。</div>}

            <div className="action-row">
              <button className="primary-button" disabled={Boolean(busy) || state.running} onClick={() => runAction("start", startMonitor, "监控已启动")}>
                {busy === "start" ? "启动中..." : "启动监控"}
              </button>
              <button className="danger-button" disabled={Boolean(busy) || !state.running} onClick={() => runAction("stop", () => api("/api/stop", { method: "POST" }), "监控已停止")}>
                停止监控
              </button>
              <button className="secondary-button" disabled={Boolean(busy)} onClick={() => runAction("open", () => api("/api/browser/open", { method: "POST" }), "已打开本地浏览器")}>
                打开/登录 X
              </button>
              <button className="secondary-button" disabled={Boolean(busy)} onClick={() => runAction("test", () => api("/api/dingtalk/test", { method: "POST", body: JSON.stringify({ dingTalkWebhook: form.dingTalkWebhook, dingTalkSecret: form.dingTalkSecret }) }), "钉钉测试已发送")}>
                测试钉钉
              </button>
              <button className="secondary-button" disabled={Boolean(busy)} onClick={() => runAction("sync", syncLatestWithSave, "已同步最近推文")}>
                同步最近
              </button>
              <button className="secondary-button" disabled={Boolean(busy)} onClick={() => runAction("reset-seen", () => api("/api/seen/reset", { method: "POST" }), "已重置去重记录")}>
                重置去重
              </button>
            </div>
          </div>

          <div className="panel logs-panel" id="logs">
            <div className="panel-heading compact-heading">
              <div>
                <h2>实时日志</h2>
                <p>SSE 实时刷新，方便手动排查。</p>
              </div>
              <button className="ghost-button" onClick={() => runAction("clear", () => api("/api/logs/clear", { method: "POST" }), "日志已清空")}>清空</button>
            </div>
            <div className="terminal">
              {logs.length === 0 ? (
                <div className="empty-line">等待事件...</div>
              ) : (
                logs.map((log) => (
                  <div className={cx("log-line", log.level)} key={log.id}>
                    <time>{formatTime(log.at)}</time>
                    <strong>{log.level}</strong>
                    <span>{log.message}</span>
                    {log.meta && Object.keys(log.meta).length > 0 && <code>{JSON.stringify(log.meta)}</code>}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="panel records-panel" id="records">
          <div className="panel-heading">
            <div>
              <h2>最近推送</h2>
              <p>展示本机记录的最近 200 条捕获/推送结果。</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>博主</th>
                  <th>频道</th>
                  <th>校验</th>
                  <th>内容预览</th>
                  <th>原文发布时间</th>
                  <th>最后编辑</th>
                  <th>捕获时间</th>
                  <th>状态</th>
                  <th>翻译</th>
                  <th>原文</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr><td colSpan="10" className="empty-cell">还没有推送记录</td></tr>
                ) : (
                  records.map((item) => (
                    <tr key={item.id}>
                      <td>@{item.username}</td>
                      <td>{item.sourceLabel || browserChannelLabels[item.sourceChannel] || "旧记录"}</td>
                      <td>{item.authorVerified ? `通过 @${item.matchedAuthor || item.username}` : "旧记录/未校验"}</td>
                      <td className="preview">{item.text}</td>
                      <td>{formatTime(item.tweetCreatedAt)}</td>
                      <td>{item.tweetEditedAt ? formatTime(item.tweetEditedAt) : "未识别/无"}</td>
                      <td>{formatTime(item.createdAt)}</td>
                      <td><span className={cx("record-status", item.status)}>{item.status}</span></td>
                      <td><span className={cx("record-status", item.translationStatus)}>{item.translationStatus || "旧记录"}</span></td>
                      <td><a href={item.url} target="_blank" rel="noreferrer">打开</a></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
