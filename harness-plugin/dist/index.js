// src/index.ts
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { readFile, writeFile, mkdir, readdir, unlink, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy/api";
var name = "pet-status";
var inject = ["webServer", "apiProxy"];
var Config = z.object({
  path: z.string().default("/api/pet.ws"),
  petDir: z.string().default(""),
  autoStart: z.boolean().default(false)
});
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function sanitizeFolder(name2) {
  const s = String(name2).replace(/[^a-zA-Z0-9_-]/g, "_").replace(/__+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  if (/[a-zA-Z0-9]/.test(s)) return s;
  let h = 0;
  for (const ch of String(name2)) h = h * 31 + (ch.codePointAt(0) ?? 0) >>> 0;
  return "action_" + h.toString(36);
}
var PNG_MAGIC = "89504e470d0a1a0a";
var MAX_FRAME_DIM = 256;
function pngDims(buf) {
  if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== PNG_MAGIC) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function json(res, code, value) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
function extractText(message) {
  const content = message?.content ?? [];
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}
var ChatService = class {
  sessionId = null;
  workspacePath = null;
  workspaceId = null;
  currentModel = null;
  api;
  emit;
  onPromptAccepted;
  constructor(api, emit, onPromptAccepted) {
    this.api = api;
    this.emit = emit;
    this.onPromptAccepted = onPromptAccepted;
  }
  /** 列出所有工作区（对话文件夹），返回 {id, title, path}。 */
  async listFolders() {
    const res = await this.api.workspace.list({ rpcId: RpcId(randomUUID()), payload: {} });
    if (!res.result.ok) return [];
    return res.result.value.items.map((w) => ({ id: String(w.workspaceId), title: w.title, path: w.path }));
  }
  /** 广播文件夹列表 + 当前选中 id。 */
  async emitFolders() {
    const folders = await this.listFolders();
    this.emit({ type: "chat-folders", folders, currentId: this.workspaceId });
  }
  /** 列出某工作区下的会话（按工作区 sessionIds 顺序），返回 {id, title, updatedAt}。 */
  async listSessions(workspaceId) {
    const [listRes, wsRes] = await Promise.all([
      this.api.sessions.list({ rpcId: RpcId(randomUUID()), payload: {} }),
      this.api.workspace.list({ rpcId: RpcId(randomUUID()), payload: {} })
    ]);
    if (!listRes.result.ok || !wsRes.result.ok) return [];
    const ws = wsRes.result.value.items.find((w) => String(w.workspaceId) === workspaceId);
    const ordered = ws?.sessionIds ?? [];
    const byId = new Map(listRes.result.value.items.map((i) => [String(i.sessionId), i]));
    return ordered.map((sid, i) => {
      const it = byId.get(String(sid));
      const proj = it?.projections?.values;
      const title = typeof proj?.title === "string" && proj.title ? proj.title : "";
      return {
        id: String(sid),
        title: title || (it?.blank ? "\u65B0\u5BF9\u8BDD" : `\u5BF9\u8BDD ${i + 1}`),
        updatedAt: it?.updatedAt ?? 0
      };
    });
  }
  /** 广播当前工作区的会话列表 + 当前选中会话 id。 */
  async emitSessions() {
    if (!this.workspaceId) {
      this.emit({ type: "chat-sessions", sessions: [], currentId: null });
      return;
    }
    const sessions = await this.listSessions(this.workspaceId);
    this.emit({ type: "chat-sessions", sessions, currentId: this.sessionId });
  }
  /** 列出可用模型目录（来自 harness llm.models，非硬编码），返回 {provider, model, name, description}。 */
  async listModels() {
    const res = await this.api.llm.models({ rpcId: RpcId(randomUUID()), payload: {} });
    if (!res.result.ok) return [];
    const models = [];
    for (const group of res.result.value.groups) {
      for (const m of group.models) {
        models.push({ provider: group.id, model: m.id, name: m.name, description: m.description });
      }
    }
    return models;
  }
  /** 广播模型目录 + 当前选中模型。 */
  async emitModels() {
    const models = await this.listModels();
    this.emit({ type: "chat-models", models, current: this.currentModel });
  }
  /** 回读会话当前模型（会话属性，重开会话可恢复）。 */
  async readCurrentModel() {
    if (!this.sessionId) {
      this.currentModel = null;
      return;
    }
    try {
      const res = await this.api.sessions.models({ rpcId: RpcId(randomUUID()), payload: { sessionId: this.sessionId } });
      if (res.result.ok) {
        this.currentModel = { provider: res.result.value.current.provider, model: res.result.value.current.model };
      }
    } catch {
      this.currentModel = null;
    }
  }
  /** 切换模型（会话属性，仅影响下一次新请求；无会话则暂存，创建会话后应用）。 */
  async selectModel(provider, model) {
    const prev = this.currentModel;
    this.currentModel = { provider, model };
    if (this.sessionId) {
      try {
        const res = await this.api.sessions.selectModel({
          rpcId: RpcId(randomUUID()),
          payload: { sessionId: this.sessionId, provider, model }
        });
        if (!res.result.ok) throw new Error(res.result.error.code);
      } catch (error) {
        this.currentModel = prev;
        this.emit({ type: "chat-error", message: `\u65E0\u6CD5\u5207\u6362\u6A21\u578B\uFF0C\u8BF7\u68C0\u67E5\u6A21\u578B\u914D\u7F6E\uFF08${String(error)}\uFF09` });
        await this.emitModels();
        return;
      }
    }
    await this.emitModels();
  }
  /** 初始化：用桌宠记住的目录路径解析/创建工作区作为默认文件夹，并加载其历史。 */
  async init(workspacePath) {
    try {
      if (workspacePath) await this.ensureWorkspace(workspacePath);
    } catch {
    }
    if (this.workspaceId) await this.selectFolder(this.workspaceId);
    else {
      await this.emitFolders();
      await this.emitModels();
    }
  }
  /** 确保工作区存在（幂等）：换工作区则顺带重置会话。 */
  async ensureWorkspace(path2) {
    if (this.workspaceId && this.workspacePath === path2) return this.workspaceId;
    const res = await this.api.workspace.create({ rpcId: RpcId(randomUUID()), payload: { path: path2 } });
    if (!res.result.ok) throw new Error(`\u5DE5\u4F5C\u533A\u521B\u5EFA\u5931\u8D25\uFF1A${res.result.error.code}`);
    this.workspacePath = path2;
    this.workspaceId = String(res.result.value.workspace.workspaceId);
    this.sessionId = null;
    return this.workspaceId;
  }
  /** 切换到某文件夹：广播其会话列表，并默认进入最近会话（attach prepend：第一个最新）。 */
  async selectFolder(workspaceId) {
    this.workspaceId = workspaceId;
    this.sessionId = null;
    await this.emitFolders();
    const sessions = await this.listSessions(workspaceId);
    this.emit({ type: "chat-sessions", sessions, currentId: null });
    if (sessions.length > 0) await this.selectSession(sessions[0].id);
    else {
      this.emit({ type: "chat-history", messages: [] });
      await this.readCurrentModel();
      await this.emitModels();
    }
  }
  /** 进入某个具体会话：加载其历史并广播（会话选择器切换 / 文件夹默认进入最近会话）。 */
  async selectSession(sessionId) {
    this.sessionId = sessionId;
    const messages = await this.readHistory(sessionId);
    this.emit({ type: "chat-history", messages });
    await this.emitSessions();
    await this.readCurrentModel();
    await this.emitModels();
  }
  /** 读取某会话历史，折叠成 user/assistant 文本消息序列。 */
  async readHistory(sessionId) {
    const res = await this.api.sessions.history({ rpcId: RpcId(randomUUID()), payload: { sessionId } });
    if (!res.result.ok) return [];
    const messages = [];
    for (const entry of res.result.value.events) {
      const event = entry.event;
      if (event.type === "user/message") {
        const text = extractText(event.data);
        if (text) messages.push({ role: "user", text });
      } else if (event.type === "assistant/message") {
        const text = extractText(event.data.message);
        if (text) messages.push({ role: "assistant", text });
      }
    }
    return messages;
  }
  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    if (!this.workspaceId) throw new Error("\u672A\u9009\u62E9\u5BF9\u8BDD\u6587\u4EF6\u5939");
    const res = await this.api.sessions.create({ rpcId: RpcId(randomUUID()), payload: { workspaceId: this.workspaceId } });
    if (!res.result.ok) throw new Error(`\u4F1A\u8BDD\u521B\u5EFA\u5931\u8D25\uFF1A${res.result.error.code}`);
    this.sessionId = String(res.result.value.sessionId);
    if (this.currentModel) {
      await this.api.sessions.selectModel({
        rpcId: RpcId(randomUUID()),
        payload: { sessionId: this.sessionId, provider: this.currentModel.provider, model: this.currentModel.model }
      });
    }
    void this.emitSessions();
    return this.sessionId;
  }
  async send(text) {
    try {
      const sessionId = await this.ensureSession();
      const res = await this.api.sessions.prompt({
        rpcId: RpcId(randomUUID()),
        payload: { sessionId, mode: "queue", content: [{ type: "text", text }] }
      });
      if (!res.result.ok) throw new Error(`prompt \u5931\u8D25\uFF1A${res.result.error.code}`);
      this.onPromptAccepted?.();
      this.emit({ type: "chat-started" });
    } catch (error) {
      this.emit({ type: "chat-error", message: String(error) });
    }
  }
  /** 另起新对话：下次 send 会用新会话（当前文件夹内）。 */
  newConversation() {
    this.sessionId = null;
    void this.emitSessions();
  }
  async cancel() {
    if (!this.sessionId) return;
    const res = await this.api.sessions.cancel({ rpcId: RpcId(randomUUID()), payload: { sessionId: this.sessionId } });
    if (!res.result.ok) throw new Error(`\u6253\u65AD\u5931\u8D25\uFF1A${res.result.error.code}`);
  }
  /** 处理 mux 流帧：仅关心本会话的 assistant 文本事件（分片/完整消息/结束）。 */
  handleFrame(frame) {
    if (frame.type !== "session/event" || frame.sessionId !== this.sessionId) return;
    const event = frame.event;
    if (!event) return;
    if (event.type === "assistant/chunk") {
      const chunk = event.data?.chunk;
      if (chunk?.type === "text-delta" && chunk.text) this.emit({ type: "chat-delta", text: chunk.text });
    } else if (event.type === "assistant/message") {
      const text = extractText(event.data?.message);
      if (text) this.emit({ type: "chat-message", text });
    } else if (event.type === "turn/end") {
      this.emit({ type: "chat-done" });
    }
  }
};
function apply(ctx, config = {}) {
  const pathname = config.path ?? "/api/pet.ws";
  const server = new WebSocketServer({ noServer: true });
  const clients = /* @__PURE__ */ new Set();
  const running = /* @__PURE__ */ new Set();
  let terminated = false;
  let received = false;
  let receivedStart = 0;
  let receivedTimer = null;
  let endedTimer = null;
  const current = () => {
    if (received) return "received";
    if (running.size > 0) return "running";
    return terminated ? "terminated" : "completed";
  };
  const send = (msg) => {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };
  const broadcast = () => send({ type: "status", status: current() });
  const finishReceived = () => {
    if (!received) return;
    received = false;
    if (receivedTimer) {
      clearTimeout(receivedTimer);
      receivedTimer = null;
    }
    broadcast();
  };
  const chat = new ChatService(ctx.apiProxy, send, () => {
    received = true;
    receivedStart = Date.now();
    broadcast();
    if (receivedTimer) clearTimeout(receivedTimer);
    receivedTimer = setTimeout(() => {
      receivedTimer = null;
      finishReceived();
    }, 3e3);
  });
  const scheduleEnded = () => {
    if (endedTimer) clearTimeout(endedTimer);
    endedTimer = setTimeout(() => {
      endedTimer = null;
      broadcast();
    }, 80);
  };
  ctx.effect(() => {
    const abort = new AbortController();
    const api = ctx.apiProxy;
    const mux = api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal);
    const host = api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal);
    void (async () => {
      for await (const frame of mux) {
        const payload = frame.payload;
        chat.handleFrame(payload);
        if (payload.type !== "session/event") continue;
        const event = payload.event;
        if (event.type !== "turn/end") continue;
        const kind = event.data.reason.kind;
        terminated = kind === "error" || kind === "aborted";
      }
    })().catch(() => {
    });
    void (async () => {
      for await (const frame of host) {
        const payload = frame.payload;
        if (payload.type === "host/session-status") {
          if (payload.running) {
            running.add(payload.sessionId);
            terminated = false;
            if (endedTimer) {
              clearTimeout(endedTimer);
              endedTimer = null;
            }
            if (received) {
              const remain = receivedStart + 1200 - Date.now();
              if (remain > 0) {
                if (receivedTimer) clearTimeout(receivedTimer);
                receivedTimer = setTimeout(() => {
                  receivedTimer = null;
                  finishReceived();
                }, remain);
              } else {
                finishReceived();
              }
            } else {
              broadcast();
            }
          } else {
            running.delete(payload.sessionId);
            if (running.size === 0) scheduleEnded();
            else broadcast();
          }
        } else if (payload.type === "host/agent-error") {
          terminated = true;
        }
      }
    })().catch(() => {
    });
    return () => {
      abort.abort();
      if (endedTimer) clearTimeout(endedTimer);
      if (receivedTimer) clearTimeout(receivedTimer);
    };
  }, "pet-status: event streams");
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: pathname,
    handler: (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "status", status: current() }));
        ws.on("close", () => clients.delete(ws));
        ws.on("error", () => clients.delete(ws));
        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "chat-init") void chat.init(msg.workspacePath ?? "");
            else if (msg.type === "chat") void chat.send(msg.text ?? "");
            else if (msg.type === "chat-select-folder") void chat.selectFolder(msg.workspaceId ?? "");
            else if (msg.type === "chat-select-session") void chat.selectSession(msg.sessionId ?? "");
            else if (msg.type === "chat-select-model") void chat.selectModel(msg.provider ?? "", msg.model ?? "");
            else if (msg.type === "chat-new") chat.newConversation();
            else if (msg.type === "chat-cancel") void chat.cancel();
          } catch {
          }
        });
      });
    }
  }), "pet-status: WebSocket route");
  ctx.effect(() => () => {
    for (const ws of clients) ws.terminate();
    server.close();
  }, "pet-status: cleanup");
  const petDir = config.petDir ?? "";
  const configFile = petDir ? path.join(petDir, "pet.config.json") : "";
  let petChild = null;
  const readConfig = async () => {
    if (!configFile) return null;
    try {
      return JSON.parse(await readFile(configFile, "utf8"));
    } catch {
      return null;
    }
  };
  const writeConfig = async (cfg) => {
    await writeFile(configFile, JSON.stringify(cfg, null, 2) + "\n");
  };
  const startPet = (force = false) => {
    if (!force && !config.autoStart) return;
    if (!petDir || petChild) return;
    const electronCli = path.join(petDir, "node_modules", "electron", "cli.js");
    const wsUrl = `ws://127.0.0.1:${String(ctx.webServer.port)}${pathname}`;
    const child = spawn(process.execPath, [electronCli, "."], {
      cwd: petDir,
      env: { ...process.env, PET_WS_URL: wsUrl },
      stdio: "ignore"
    });
    petChild = child;
    const release = () => {
      if (petChild === child) petChild = null;
    };
    child.on("error", (error) => {
      console.error("[pet-status] \u62C9\u8D77\u684C\u5BA0\u5931\u8D25\uFF1A", error);
      release();
    });
    child.on("exit", (code, signal) => {
      if (signal) console.error(`[pet-status] \u684C\u5BA0\u88AB\u4FE1\u53F7 ${signal} \u7EC8\u6B62`);
      else if (code !== null && code !== 0) console.error(`[pet-status] \u684C\u5BA0\u9000\u51FA\uFF08code ${code}\uFF09`);
      release();
    });
  };
  const stopPet = () => {
    if (petChild) {
      petChild.kill();
      petChild = null;
    }
  };
  if (configFile) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/api/pet.config",
      handler: async (req, res) => {
        if (req.method === "GET") {
          try {
            const text = await readFile(configFile, "utf8");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(text);
          } catch {
            json(res, 404, { ok: false, error: "config not found" });
          }
        } else if (req.method === "PUT") {
          try {
            const cfg = JSON.parse(await readBody(req));
            await writeConfig(cfg);
            json(res, 200, { ok: true });
          } catch (error) {
            json(res, 400, { ok: false, error: String(error) });
          }
        } else {
          res.writeHead(405);
          res.end();
        }
      }
    }), "pet-status: config API");
  }
  if (configFile && petDir) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/api/pet.frames",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        try {
          const { action, label, fps, frames, folder: folderArg } = JSON.parse(await readBody(req));
          if (typeof action !== "string" || !action) throw new Error("action \u5FC5\u586B");
          if (!Array.isArray(frames) || frames.length === 0) throw new Error("frames \u81F3\u5C11\u4E00\u5F20");
          if (folderArg !== void 0 && (typeof folderArg !== "string" || !/^[a-zA-Z0-9_-]+$/.test(folderArg))) throw new Error("\u5E27\u76EE\u5F55\u4EC5\u5141\u8BB8\u82F1\u6587/\u6570\u5B57/\u4E0B\u5212\u7EBF/\u8FDE\u5B57\u7B26");
          const cfg = await readConfig();
          if (cfg === null) throw new Error("config not found");
          const actions = cfg.actions ?? {};
          const existing = actions[action];
          const folder = folderArg || existing?.folder || sanitizeFolder(action);
          const bufs = [];
          for (let i = 0; i < frames.length; i++) {
            const data = frames[i]?.data;
            if (typeof data !== "string") throw new Error(`frame ${i} \u7F3A\u5C11 data`);
            const buf = Buffer.from(data, "base64");
            const dims = pngDims(buf);
            if (!dims) throw new Error(`frame ${i} \u4E0D\u662F PNG`);
            if (dims.w > MAX_FRAME_DIM || dims.h > MAX_FRAME_DIM) {
              throw new Error(`frame ${i} \u5C3A\u5BF8 ${dims.w}\xD7${dims.h} \u8D85\u51FA\u4E0A\u9650 ${MAX_FRAME_DIM}\xD7${MAX_FRAME_DIM}\uFF0C\u8BF7\u4E0A\u4F20\u50CF\u7D20\u7CBE\u7075\u5E27`);
            }
            bufs.push(buf);
          }
          const frameDir = path.join(petDir, "Deepseek", "animations", folder, "south");
          await mkdir(frameDir, { recursive: true });
          for (const f of await readdir(frameDir).catch(() => [])) {
            if (f.endsWith(".png")) await unlink(path.join(frameDir, f));
          }
          for (let i = 0; i < bufs.length; i++) {
            await writeFile(path.join(frameDir, `frame_${String(i).padStart(3, "0")}.png`), bufs[i]);
          }
          actions[action] = {
            label: label !== void 0 ? String(label) : existing?.label ?? action,
            fps: fps !== void 0 ? Number(fps) : existing?.fps ?? 5,
            folder,
            count: frames.length
          };
          cfg.actions = actions;
          await writeConfig(cfg);
          json(res, 200, { ok: true, action, folder, count: frames.length });
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) });
        }
      }
    }), "pet-status: frames API");
    ctx.effect(() => ctx.webServer.register({
      kind: "prefix",
      path: "/pet/frames",
      handler: async (req, res) => {
        const rel = (req.url ?? "").split("?")[0].slice("/pet/frames/".length);
        const parts = rel.split("/");
        if (parts.length !== 2) {
          res.writeHead(404);
          res.end();
          return;
        }
        const [folder, file] = parts;
        if (!/^[a-zA-Z0-9_-]+$/.test(folder) || !/^frame_\d{3}\.png$/.test(file)) {
          res.writeHead(404);
          res.end();
          return;
        }
        try {
          const buf = await readFile(path.join(petDir, "Deepseek", "animations", folder, "south", file));
          res.writeHead(200, { "content-type": "image/png" });
          res.end(buf);
        } catch {
          res.writeHead(404);
          res.end();
        }
      }
    }), "pet-status: frames preview");
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/api/pet.start",
      handler: (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        startPet(true);
        json(res, 200, { ok: true });
      }
    }), "pet-status: pet start");
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/api/pet.restart",
      handler: (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        stopPet();
        startPet();
        json(res, 200, { ok: true });
      }
    }), "pet-status: restart");
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/api/pet.action",
      handler: async (req, res) => {
        if (req.method !== "DELETE") {
          res.writeHead(405);
          res.end();
          return;
        }
        try {
          const { action } = JSON.parse(await readBody(req));
          if (typeof action !== "string" || !action) throw new Error("action \u5FC5\u586B");
          const cfg = await readConfig();
          if (cfg === null) throw new Error("config not found");
          const actions = cfg.actions ?? {};
          if (!actions[action]) throw new Error(`\u52A8\u4F5C "${action}" \u4E0D\u5B58\u5728`);
          const rest = Object.keys(actions).filter((k) => k !== action);
          if (rest.length === 0) throw new Error("\u4E0D\u80FD\u5220\u9664\u6700\u540E\u4E00\u4E2A\u52A8\u4F5C");
          const fallback = rest.includes("idle") ? "idle" : rest[0];
          const cs = cfg.characterStates ?? {};
          const repointPlay = (key) => {
            const st = cs[key];
            if (!st || !Array.isArray(st.play)) return;
            st.play = st.play.filter((a) => a !== action);
            if (st.play.length === 0) st.play = [fallback];
          };
          repointPlay("default");
          repointPlay("click");
          if (cs.click && cs.click.returnTo === action) cs.click.returnTo = fallback;
          if (cs.drag) {
            if (cs.drag.returnTo === action) cs.drag.returnTo = fallback;
            if (cs.drag.directions) {
              for (const d of Object.values(cs.drag.directions)) {
                if (Array.isArray(d.play)) {
                  d.play = d.play.filter((a) => a !== action);
                  if (d.play.length === 0) d.play = [fallback];
                }
              }
            }
          }
          if (cs.timeout) {
            if (cs.timeout.before === action) cs.timeout.before = fallback;
            if (cs.timeout.after === action) cs.timeout.after = fallback;
          }
          const statuses = cfg.statuses ?? {};
          for (const s of Object.values(statuses)) {
            if (Array.isArray(s.actions)) {
              s.actions = s.actions.filter((a) => a !== action);
            }
          }
          const folder = actions[action].folder;
          delete actions[action];
          cfg.actions = actions;
          if (/^[a-zA-Z0-9_-]+$/.test(folder)) {
            await rm(path.join(petDir, "Deepseek", "animations", folder), { recursive: true, force: true });
          }
          await writeConfig(cfg);
          json(res, 200, { ok: true, action, fallback });
        } catch (error) {
          json(res, 400, { ok: false, error: String(error) });
        }
      }
    }), "pet-status: action delete");
  }
  const settingsHtmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../settings.html");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/pet/settings",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const html = await readFile(settingsHtmlPath, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("settings page not found");
      }
    }
  }), "pet-status: settings page");
  ctx.effect(() => () => stopPet(), "pet-status: pet subprocess");
  startPet();
}
export {
  Config,
  apply,
  inject,
  name
};
