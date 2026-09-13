/*
 * store.js —— 持久化 / 撤销重做 / 版本快照与回滚 / 双页并发裁决 / 刷新恢复
 *
 * 可在无浏览器环境注入 { storage, channel, addEvent, now } 做自动化测试。
 *
 * 并发模型：
 *  - 所有页面共享 localStorage 中的权威状态 envelope { state, rev, snapshots }。
 *  - 每次成功 commit：在本页基于当前 state 应用动作 → rev+1 → 广播消息 {baseRev,rev,action,actor}。
 *  - 其他页收到消息：若 baseRev === 本页 rev，直接应用（快进）；否则在本页 state 上重放动作，
 *    重放失败说明两页动作互斥（双页竞争），本页保留状态、发 conflict 事件并写冲突审计，
 *    权威存储以先提交者为准，后提交者必须刷新后重试——不会静默丢数据。
 *  - 记录编辑锁（30 秒租约 + 心跳）用于表单级互斥，避免两页同时编辑同一条记录。
 *
 * 撤销/重做：成功写动作把提交前完整状态压入 undo 栈；任何跨页变更都会清空本页 undo 栈。
 * 版本：每 5 次写自动快照（保留 20 个），可手动打快照，可回滚（回滚前自动备份当前状态）。
 * 刷新恢复：成功动作即时落 localStorage；表单草稿存 sessionStorage/localStorage 可恢复。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"));
  else root.Store = factory(root.Core);
})(typeof self !== "undefined" ? self : this, function (Core) {
  "use strict";

  const DATA_KEY = "digitdesk:data:v1";
  const LOCKS_KEY = "digitdesk:locks:v1";
  const PRESENCE_KEY = "digitdesk:presence:v1";
  const DRAFT_PREFIX = "digitdesk:draft:";

  const UNDO_LIMIT = 50;
  const SNAPSHOT_LIMIT = 20;
  const LOCK_TTL_MS = 30000;
  const HEARTBEAT_MS = 10000;

  // 浏览器全局对象（严格模式下必须经对象调用，否则 this=undefined 抛 Illegal invocation）
  const g = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this;

  function memoryStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
      key: (i) => Array.from(m.keys())[i] || null,
      get length() { return m.size; },
      _dump: () => Object.fromEntries(m)
    };
  }

  /** 测试用消息总线，等价于跨标签页的 BroadcastChannel */
  function memoryBus() {
    const peers = new Set();
    return {
      connect(handler) {
        const node = { handler };
        peers.add(node);
        return {
          post(msg) {
            for (const p of peers) if (p !== node) setTimeout(() => p.handler(msg), 0);
          },
          close() {
            peers.delete(node);
          }
        };
      }
    };
  }

  class Store {
    constructor(options) {
      options = options || {};
      this.pageId = options.pageId || "page_" + Math.random().toString(36).slice(2, 10);
      this.tabName = options.tabName || "标签页";
      this.role = options.role || "admin";
      this.userName = options.userName || "管理员";
      this.storage = options.storage || (typeof localStorage !== "undefined" ? localStorage : memoryStorage());
      this.now = options.now || (() => Date.now());
      this.bus = options.bus || null;
      this._addEventListener = options.addEventListener || (typeof g.addEventListener === "function" ? g.addEventListener.bind(g) : null);
      this._removeEventListener = options.removeEventListener || (typeof g.removeEventListener === "function" ? g.removeEventListener.bind(g) : null);

      this.rev = 0;
      this.undoStack = [];
      this.redoStack = [];
      this.snapshots = [];
      this.writesSinceSnapshot = 0;
      this.seenMsg = new Set();
      this._listeners = {};

      this._load();

      // 跨页消息：注入的 bus（测试）/ BroadcastChannel / storage 事件兜底
      if (this.bus) {
        this._busConn = this.bus.connect((msg) => this._onRemote(msg));
      } else if (typeof BroadcastChannel !== "undefined" && options.channel !== false) {
        try {
          this._bc = new BroadcastChannel("digitdesk");
          this._bc.addEventListener("message", (ev) => this._onRemote(ev.data));
        } catch {}
      }
      if (!this.bus && !this._bc && this._addEventListener) {
        this._storageHandler = (ev) => {
          if (ev.key === DATA_KEY && ev.newValue) {
            try {
              const env = JSON.parse(ev.newValue);
              if (env.__msg) this._onRemote(env.__msg);
            } catch {}
          }
          if (ev.key === LOCKS_KEY) this.emit("locks");
          if (ev.key === PRESENCE_KEY) this.emit("presence");
        };
        this._addEventListener("storage", this._storageHandler);
      }
      if (this._addEventListener) {
        this._unloadHandler = () => this.flushOnExit();
        this._addEventListener("beforeunload", this._unloadHandler);
      }

      this._registerPresence();
      this._startHeartbeat();
    }

    on(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    off(type, fn) {
      this._listeners[type] = (this._listeners[type] || []).filter((x) => x !== fn);
    }
    emit(type, detail) {
      // EventTarget 风格（浏览器中 EventTarget 在父类；这里用自实现，Node 下也能用）
      for (const fn of this._listeners[type] || []) fn({ type, detail });
    }

    ctx() {
      return { role: this.role, userName: this.userName };
    }
    setActor(role, userName) {
      this.role = role;
      this.userName = userName || (Core.ROLES[role] ? Core.ROLES[role].name : role);
      this._registerPresence();
    }

    /* ===================== 持久化 ===================== */

    _load() {
      const raw = this.storage.getItem(DATA_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed.state) throw new Error("bad envelope");
          this.state = parsed.state;
          this.rev = parsed.rev || 0;
          this.snapshots = parsed.snapshots || [];
          this.writesSinceSnapshot = parsed.writesSinceSnapshot || 0;
        } catch {
          this.state = Core.seedState();
          this._writeEnvelope("损坏数据已重置");
        }
      } else {
        this.state = Core.seedState();
        this._writeEnvelope("初始化演示数据");
      }
      if (!this.state.audit) this.state.audit = [];
    }

    _writeEnvelope(reason, msg) {
      const envelope = {
        state: this.state,
        rev: this.rev,
        snapshots: this.snapshots,
        writesSinceSnapshot: this.writesSinceSnapshot,
        savedAt: this.now(),
        reason,
        __msg: msg || null
      };
      try {
        this.storage.setItem(DATA_KEY, JSON.stringify(envelope));
      } catch (e) {
        this.emit("denied", [{ message: "本地存储写入失败（空间不足？）：" + e.message }]);
      }
    }

    _broadcast(msg) {
      if (this._busConn) this._busConn.post(msg);
      if (this._bc) {
        try {
          this._bc.postMessage(msg);
        } catch {}
      }
      // storage 事件兜底：把消息放进 envelope.__msg（写入动作在 _writeEnvelope 完成）
    }

    /* ===================== 提交 ===================== */

    commit(action, opts) {
      const baseRev = this.rev;
      const result = Core.dispatch(this.state, action, this.ctx());
      if (result.errors.length) {
        // 被拒动作：业务数据零改动，仅追加拒绝审计
        if (result.state && result.state.audit && result.state.audit !== this.state.audit) {
          this.state.audit = result.state.audit;
          this._writeEnvelope("denied-audit");
        }
        this.emit("denied", result.errors);
        return result;
      }

      if (!opts || opts.undoable !== false) {
        this.undoStack.push({
          label: actionLabel(action),
          action: structuredClone(action),
          before: structuredClone(this.state),
          rev: this.rev
        });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.redoStack = [];
      }

      this.state = result.state;
      this.rev += 1;
      this.writesSinceSnapshot += 1;
      if (this.writesSinceSnapshot >= 5) {
        this._takeSnapshot("自动版本", false, true);
      }

      const msg = {
        id: Core.uid("msg"),
        kind: "commit",
        pageId: this.pageId,
        rev: this.rev,
        baseRev,
        action: structuredClone(action),
        actor: this.ctx()
      };
      this._writeEnvelope(action.type, msg);
      this._broadcast(msg);
      this.emit("change", { origin: "local", action });
      return result;
    }

    _adoptDeniedAudit(work) {
      // 被拒绝动作可能在工作副本里追加了 denied 审计行，把新增行搬回权威状态并落盘
      const oldLen = this.state.audit.length;
      const newLen = work.audit.length;
      if (newLen > oldLen) {
        this.state.audit = work.audit;
        this._writeEnvelope("denied-audit");
      }
    }

    /* ===================== 撤销 / 重做 ===================== */

    canUndo() {
      return this.undoStack.length > 0;
    }
    canRedo() {
      return this.redoStack.length > 0;
    }

    undo() {
      const entry = this.undoStack[this.undoStack.length - 1];
      if (!entry) return { errors: [{ message: "没有可撤销的操作" }] };
      if (entry.rev !== this.rev - 1) {
        const msg = `数据已被其他页面改动（撤销点 rev=${entry.rev}，当前 rev=${this.rev}），不能安全撤销，请用版本回滚`;
        this.emit("denied", [{ message: msg }]);
        return { errors: [{ message: msg }] };
      }
      this.undoStack.pop();
      const current = structuredClone(this.state);
      this.state = entry.before;
      this.rev += 1;
      this.redoStack.push({ label: entry.label, action: entry.action, after: current });
      Core.audit(this.state, {
        actor: this.userName,
        role: this.role,
        action: "撤销操作",
        target: entry.label,
        detail: `撤销后回到 rev=${entry.rev}`
      });
      this._remoteReplace("undo:" + entry.label);
      this.emit("change", { origin: "local", action: { type: "undo" } });
      return { state: this.state, events: [], errors: [] };
    }

    redo() {
      const entry = this.redoStack.pop();
      if (!entry) return { errors: [{ message: "没有可重做的操作" }] };
      const result = Core.dispatch(this.state, entry.action, this.ctx());
      if (result.errors.length) {
        this.redoStack.push(entry);
        this.emit("denied", result.errors);
        return result;
      }
      this.state = result.state;
      this.rev += 1;
      this.undoStack.push({ label: entry.label, action: entry.action, before: entry.after, rev: this.rev - 1 });
      Core.audit(this.state, { actor: this.userName, role: this.role, action: "重做操作", target: entry.label });
      this._remoteReplace("redo:" + entry.label);
      this.emit("change", { origin: "local", action: { type: "redo" } });
      return result;
    }

    /* ===================== 版本快照 / 回滚 ===================== */

    takeSnapshot(label) {
      return this._takeSnapshot(label || "手动版本", true, false);
    }

    _takeSnapshot(label, manual, silent) {
      const snap = {
        id: Core.uid("snap"),
        label,
        at: new Date(this.now()).toISOString(),
        rev: this.rev,
        by: this.userName,
        manual,
        state: structuredClone(this.state)
      };
      this.snapshots.push(snap);
      if (this.snapshots.length > SNAPSHOT_LIMIT) this.snapshots.shift();
      this.writesSinceSnapshot = 0;
      this._writeEnvelope("snapshot");
      if (!silent) this.emit("snapshots");
      return snap;
    }

    listSnapshots() {
      return this.snapshots
        .slice()
        .reverse()
        .map((s) => ({
          id: s.id,
          label: s.label,
          at: s.at.slice(0, 19).replace("T", " "),
          rev: s.rev,
          by: s.by,
          manual: s.manual
        }));
    }

    rollback(snapshotId) {
      const snap = this.snapshots.find((x) => x.id === snapshotId);
      if (!snap) {
        const msg = "要回滚的版本不存在（可能已被自动清理）";
        this.emit("denied", [{ message: msg }]);
        return { errors: [{ message: msg }] };
      }
      // 回滚前自动备份当前状态，因此回滚本身也可再回滚
      this._takeSnapshot("回滚前自动备份", false, true);
      const fromRev = this.rev;
      this.state = structuredClone(snap.state);
      this.rev += 1;
      Core.audit(this.state, {
        actor: this.userName,
        role: this.role,
        action: "版本回滚",
        target: `${snap.label}（rev=${snap.rev}）`,
        detail: `从 rev=${fromRev} 回滚；回滚前状态已自动备份`
      });
      this.undoStack = [];
      this.redoStack = [];
      this._remoteReplace("rollback:" + snap.id);
      this.emit("change", { origin: "local", action: { type: "rollback" } });
      this.emit("snapshots");
      return { state: this.state, errors: [] };
    }

    resetToDemo() {
      this._takeSnapshot("重置前自动备份", false, true);
      this.state = Core.seedState();
      this.rev += 1;
      Core.audit(this.state, { actor: this.userName, role: this.role, action: "重置演示数据", target: "" });
      this.undoStack = [];
      this.redoStack = [];
      this._remoteReplace("reset");
      this.emit("change", { origin: "local", action: { type: "reset" } });
    }

    _remoteReplace(reason) {
      this._writeEnvelope(reason, {
        id: Core.uid("msg"),
        kind: "replace",
        pageId: this.pageId,
        rev: this.rev,
        reason
      });
      this._broadcast({ kind: "replace", pageId: this.pageId, rev: this.rev, reason });
    }

    /* ===================== 跨页并发 ===================== */

    _onRemote(msg) {
      if (!msg || msg.pageId === this.pageId) return;
      if (msg.id) {
        if (this.seenMsg.has(msg.id)) return;
        this.seenMsg.add(msg.id);
        if (this.seenMsg.size > 500) this.seenMsg = new Set(Array.from(this.seenMsg).slice(-300));
      }

      if (msg.kind === "commit") {
        // 快进：对方正好基于本页 rev 提交
        if (msg.baseRev === this.rev) {
          const result = Core.dispatch(this.state, msg.action, msg.actor);
          if (!result.errors.length) {
            this.state = result.state;
            this.rev = msg.rev;
            this.undoStack = [];
            this.redoStack = [];
            this.emit("change", { origin: "remote", action: msg.action, actor: msg.actor });
            return;
          }
        }
        // 重放：本页已有本地之后的提交（理论上本地提交已广播，这里处理消息乱序/竞赛）
        const result = Core.dispatch(this.state, msg.action, msg.actor);
        if (!result.errors.length) {
          this.state = result.state;
          this.rev = Math.max(this.rev, msg.rev) + 1;
          this.undoStack = [];
          this.redoStack = [];
          this._writeEnvelope("replay-merge");
          this.emit("change", { origin: "remote", action: msg.action, actor: msg.actor, replayed: true });
        } else {
          // 双页竞争：两页动作互斥。以存储权威状态为准（先到者），本页提示冲突
          const raw = this.storage.getItem(DATA_KEY);
          let authoritativeNote = "";
          if (raw) {
            try {
              const env = JSON.parse(raw);
              if (env.rev >= msg.rev) {
                env.state = env.state || this.state;
                Core.audit(env.state, {
                  actor: this.userName,
                  role: this.role,
                  action: "并发冲突",
                  target: msg.action.type,
                  detail: `页面「${msg.actor.userName || msg.actor.role}」的操作在本页重放失败：${result.errors
                    .map((e) => e.message.replace(/^拒绝：/, ""))
                    .join("；")}。以先提交者为准，本页已加载权威数据`,
                  result: "conflict"
                });
                this.state = env.state;
                this.rev = env.rev;
                this.snapshots = env.snapshots || this.snapshots;
                this._writeEnvelope("conflict-audit");
                authoritativeNote = "已加载对方先提交的权威数据";
              }
            } catch {}
          }
          this.undoStack = [];
          this.redoStack = [];
          this.emit("conflict", {
            remote: msg,
            errors: result.errors,
            message: `与另一页面（${msg.actor.userName || msg.actor.role}）的操作冲突：${result.errors
              .map((e) => e.message.replace(/^拒绝：/, ""))
              .join("；")}。${authoritativeNote}，请在最新数据上重试。`
          });
        }
      } else if (msg.kind === "replace") {
        // 其他页 undo/redo/回滚/重置：权威状态整体替换
        const raw = this.storage.getItem(DATA_KEY);
        if (raw) {
          try {
            const env = JSON.parse(raw);
            this.state = env.state;
            this.rev = env.rev;
            this.snapshots = env.snapshots || this.snapshots;
            this.undoStack = [];
            this.redoStack = [];
            this.emit("change", { origin: "remote", action: { type: msg.reason } });
          } catch {}
        }
      }
    }

    /* ===================== 记录编辑锁（双页竞争） ===================== */

    _readLocks() {
      try {
        return JSON.parse(this.storage.getItem(LOCKS_KEY) || "{}");
      } catch {
        return {};
      }
    }
    _writeLocks(locks) {
      this.storage.setItem(LOCKS_KEY, JSON.stringify(locks));
      this.emit("locks");
    }
    _expireLocks(locks, t) {
      for (const [k, v] of Object.entries(locks)) if (t - v.at > LOCK_TTL_MS) delete locks[k];
    }

    /** 尝试加锁。被占用时返回 {ok:false, holder} */
    acquireLock(entity, id, meta) {
      const locks = this._readLocks();
      const t = this.now();
      this._expireLocks(locks, t);
      const key = entity + ":" + id;
      const cur = locks[key];
      if (cur && cur.pageId !== this.pageId) return { ok: false, holder: cur };
      locks[key] = { pageId: this.pageId, tabName: this.tabName, role: this.role, by: this.userName, entity, id, meta: meta || {}, at: t };
      this._writeLocks(locks);
      return { ok: true };
    }

    releaseLock(entity, id) {
      const locks = this._readLocks();
      const key = entity + ":" + id;
      if (locks[key] && locks[key].pageId === this.pageId) {
        delete locks[key];
        this._writeLocks(locks);
      }
      return { ok: true };
    }

    releaseAllMyLocks() {
      const locks = this._readLocks();
      let changed = false;
      for (const [k, v] of Object.entries(locks)) {
        if (v.pageId === this.pageId) {
          delete locks[k];
          changed = true;
        }
      }
      if (changed) this._writeLocks(locks);
    }

    listLocks() {
      const locks = this._readLocks();
      this._expireLocks(locks, this.now());
      return Object.values(locks).map((v) => Object.assign({ mine: v.pageId === this.pageId }, v));
    }

    flushOnExit() {
      this.releaseAllMyLocks();
      this._unregisterPresence();
      if (this._busConn) this._busConn.close();
    }

    /* ===================== 在线页面 ===================== */

    _readPresence() {
      try {
        return JSON.parse(this.storage.getItem(PRESENCE_KEY) || "{}");
      } catch {
        return {};
      }
    }
    _registerPresence(silent) {
      const t = this.now();
      const all = this._readPresence();
      for (const [k, v] of Object.entries(all)) if (t - v.at > LOCK_TTL_MS * 2) delete all[k];
      all[this.pageId] = { pageId: this.pageId, tabName: this.tabName, role: this.role, by: this.userName, at: t };
      this.storage.setItem(PRESENCE_KEY, JSON.stringify(all));
      if (!silent) this.emit("presence");
    }
    _unregisterPresence() {
      const all = this._readPresence();
      delete all[this.pageId];
      this.storage.setItem(PRESENCE_KEY, JSON.stringify(all));
    }
    listPresence() {
      const all = this._readPresence();
      const t = this.now();
      return Object.values(all).filter((v) => t - v.at <= LOCK_TTL_MS * 2);
    }

    _startHeartbeat() {
      if (typeof setInterval !== "function") return;
      this._heartbeat = setInterval(() => {
        const locks = this._readLocks();
        let touched = false;
        for (const v of Object.values(locks)) {
          if (v.pageId === this.pageId) {
            v.at = this.now();
            touched = true;
          }
        }
        if (touched) this.storage.setItem(LOCKS_KEY, JSON.stringify(locks));
        this._registerPresence(true);
      }, HEARTBEAT_MS);
    }

    /* ===================== 表单草稿（刷新恢复） ===================== */

    saveDraft(key, draft) {
      this.storage.setItem(
        DRAFT_PREFIX + key,
        JSON.stringify({ at: this.now(), pageId: this.pageId, draft })
      );
    }
    loadDraft(key) {
      const raw = this.storage.getItem(DRAFT_PREFIX + key);
      if (!raw) return null;
      try {
        return JSON.parse(raw).draft;
      } catch {
        return null;
      }
    }
    clearDraft(key) {
      this.storage.removeItem(DRAFT_PREFIX + key);
    }
    listDrafts() {
      const out = [];
      // 使用标准 Web Storage 枚举接口（length/key），真实 localStorage 与测试内存实现通用
      const n = typeof this.storage.length === "number" ? this.storage.length : 0;
      for (let i = 0; i < n; i++) {
        const full = this.storage.key(i);
        if (!full || !full.startsWith(DRAFT_PREFIX)) continue;
        try {
          const p = JSON.parse(this.storage.getItem(full));
          out.push({ key: full.slice(DRAFT_PREFIX.length), at: p.at, pageId: p.pageId, draft: p.draft });
        } catch {}
      }
      return out.sort((a, b) => b.at - a.at);
    }
  }

  function actionLabel(action) {
    const map = {
      saveVendor: "保存外包商",
      saveContract: "保存合同",
      saveReel: "保存胶片卷",
      saveBatch: "保存扫描批次",
      transitionBatch: "批次流转",
      acceptBatch: "验收登记",
      saveDefect: "保存缺陷",
      transitionDefect: "缺陷流转",
      saveMilestone: "保存付款节点",
      savePayment: "保存付款单",
      approvePayment: "审批付款",
      rejectPayment: "驳回付款",
      payPayment: "付款确认",
      deleteEntity: "删除记录",
      importBundle: "导入档案"
    };
    return map[action.type] || action.type;
  }

  return { Store, memoryStorage, memoryBus, constants: { DATA_KEY, LOCKS_KEY, PRESENCE_KEY, DRAFT_PREFIX, LOCK_TTL_MS } };
});
