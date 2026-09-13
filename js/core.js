/*
 * core.js —— 离线数字化验收与付款台：纯业务规则核心（无 DOM 依赖）
 *
 * 所有会改动数据的动作都经过 reducer：dispatch(state, action, ctx) -> { state, events, errors }
 * UI / 测试 / 导入 只构造 action，不直接写数据。所有被拒绝的动作同样产生审计事件（denied）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ============================== 常量 ============================== */

  const ROLES = {
    admin: { name: "管理员", approver: false, level: 0, limits: { paymentCreate: 2000000 } },
    qc: { name: "质检员", approver: false, level: 0, limits: { paymentCreate: 0 } },
    pm: { name: "项目经理", approver: true, level: 1, limits: { paymentCreate: 500000 } },
    finance: { name: "财务", approver: true, level: 2, limits: { paymentCreate: 2000000 } },
    director: { name: "分管领导", approver: true, level: 3, limits: { paymentCreate: 0 } }
  };

  const BATCH_STATUSES = ["待扫描", "验收", "返工", "通过", "冻结"];

  // 批次状态流转表（undefined = 非法流转）
  const BATCH_TRANSITIONS = {
    "待扫描": { "验收": 1, "冻结": 1 },
    "验收": { "返工": 1, "通过": 1, "冻结": 1 },
    "返工": { "验收": 1, "冻结": 1 },
    "通过": { "冻结": 1 },
    "冻结": { "待扫描": 1, "验收": 1, "返工": 1, "通过": 1 }
  };

  // 审批金额阈值：net <= 8000 项目经理终审；<=100000 财务终审；更高需分管领导
  const APPROVAL_STEPS = [
    { level: 1, role: "pm", label: "项目经理审批", max: 8000 },
    { level: 2, role: "finance", label: "财务复核", max: 100000 },
    { level: 3, role: "director", label: "分管领导批准", max: Infinity }
  ];

  const SEVERITY_CRITICAL = "关键";
  const DEFECT_SEVERITIES = ["关键", "主要", "一般"];
  const DEFECT_STATUS = ["待整改", "已返工待复验", "闭环"];
  const PAYMENT_STATUSES = ["草稿", "待审批", "审批中", "已批准", "已付款", "驳回"];

  const ERR_PREFIX = "拒绝：";

  /* ============================== 工具 ============================== */

  function uid(prefix) {
    const rnd =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `${prefix || "id"}_${Date.now().toString(36)}_${rnd}`;
  }

  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value === "string" && value.trim() !== "") {
      // 金额只允许数字（可带千分位/货币符号），不允许 12abc 之类
      const cleaned = value.replace(/[¥,，\s]/g, "");
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN;
      return Number(cleaned);
    }
    return NaN;
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  /**
   * 民用日历校验：只认 YYYY-MM-DD，按公历“年月日”是否真实存在判断，
   * 完全不经过 Date/时区转换——因此在 UTC、UTC+8、UTC-X 任意时区结果一致
   * （避免“本地零点 toISOString 变成前一天”把合法日期误判为非法）。
   */
  function isValidDate(value) {
    if (value == null || value === "") return false;
    if (typeof value === "number") return Number.isFinite(value) && value > -8.64e15 && value < 8.64e15;
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    const s = String(value).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12) return false;
    if (d < 1 || d > daysInMonth(y, mo)) return false;
    return true;
  }

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  function daysInMonth(y, mo) {
    const feb = isLeapYear(y) ? 29 : 28;
    return [31, feb, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  }

  /** 本地时区下的“今天”（YYYY-MM-DD）。扫描日/到期日均按本地日历，不做 UTC 换算。 */
  function today() {
    const d = new Date();
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${day}`;
  }

  function esc(s) {
    return String(s == null ? "" : s);
  }

  function byCode(list, code) {
    return list.find((x) => x.code === code);
  }
  function byId(list, id) {
    return list.find((x) => x.id === id);
  }

  /**
   * 在有向边集合中检测从给定节点出发能否回到自身（循环引用）。
   * edges: Map<node, node[]>
   */
  function detectCycleFrom(start, edges) {
    const stack = [[start, 0]];
    const seen = new Set();
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (node === start && depth > 0) return true;
      if (depth > 0 && node === start) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      const next = edges.get(node);
      if (next) for (const n of next) stack.push([n, depth + 1]);
    }
    return false;
  }

  function findAnyCycle(edges) {
    const visited = new Set();
    for (const node of edges.keys()) {
      if (visited.has(node)) continue;
      const stateN = new Set();
      const stack = [[node, false]];
      while (stack.length) {
        const [n, left] = stack.pop();
        if (left) {
          stateN.delete(n);
          visited.add(n);
          continue;
        }
        if (stateN.has(n)) return n;
        stateN.add(n);
        stack.push([n, true]);
        const next = edges.get(n);
        if (next) for (const m of next) if (!visited.has(m)) stack.push([m, false]);
      }
    }
    return null;
  }

  /* ============================== 选择器 / 计算 ============================== */

  function contractOf(state, contractId) {
    return byId(state.contracts, contractId);
  }

  function batchContract(state, batch) {
    const reel = byId(state.reels, batch.reelId);
    return reel ? byId(state.contracts, reel.contractId) : null;
  }

  function openCriticalDefectIds(state, batchId) {
    return state.defects
      .filter((d) => d.batchId === batchId && d.severity === SEVERITY_CRITICAL && d.status !== "闭环")
      .map((d) => d.id);
  }

  function batchAcceptedFrames(batch) {
    return Math.max(0, Math.min(batch.frames, batch.passedFrames || 0));
  }

  function batchPassRatio(batch) {
    if (!batch.frames) return 0;
    return batchAcceptedFrames(batch) / batch.frames;
  }

  function batchGrossValue(state, batch) {
    const contract = batchContract(state, batch);
    const price = contract ? Number(contract.unitPrice) || 0 : 0;
    return round2(batchAcceptedFrames(batch) * price);
  }

  function contractStats(state, contractId) {
    const contract = byId(state.contracts, contractId);
    if (!contract) return null;
    const reelIds = new Set(state.reels.filter((r) => r.contractId === contractId).map((r) => r.id));
    const batches = state.batches.filter((b) => reelIds.has(b.reelId));
    const passedFrames = batches.reduce((s, b) => s + batchAcceptedFrames(b), 0);
    const totalFrames = batches.reduce((s, b) => s + (Number(b.frames) || 0), 0);
    const payments = state.payments.filter((p) => p.contractId === contractId);
    const committed = payments
      .filter((p) => ["待审批", "审批中", "已批准", "已付款"].includes(p.status))
      .reduce((s, p) => s + Number(p.gross || 0), 0);
    const paid = payments.filter((p) => p.status === "已付款").reduce((s, p) => s + Number(p.net || 0), 0);
    return {
      contract,
      batches,
      passedFrames,
      totalFrames,
      passRatio: totalFrames ? passedFrames / totalFrames : 0,
      committed,
      paid,
      remaining: round2((Number(contract.budget) || 0) - committed)
    };
  }

  function milestoneStats(state, milestoneId) {
    const m = byId(state.milestones, milestoneId);
    if (!m) return null;
    const committed = state.payments
      .filter((p) => p.milestoneId === milestoneId && ["待审批", "审批中", "已批准", "已付款"].includes(p.status))
      .reduce((s, p) => s + Number(p.gross || 0), 0);
    return { milestone: m, committed: round2(committed), remaining: round2((Number(m.amount) || 0) - committed) };
  }

  function requiredLevelFor(amount) {
    const step = APPROVAL_STEPS.find((s) => amount <= s.max);
    return step ? step.level : 3;
  }

  function requiredSteps(amount) {
    const lvl = requiredLevelFor(amount);
    return APPROVAL_STEPS.filter((s) => s.level <= lvl);
  }

  /** 计算付款单金额（gross=合格帧产值合计；deductions 另录；net=gross-扣款-保证金扣留） */
  function computePaymentAmounts(state, p) {
    const batches = (p.batchIds || [])
      .map((id) => byId(state.batches, id))
      .filter(Boolean);
    const gross = round2(batches.reduce((s, b) => s + batchGrossValue(state, b), 0));
    const deductions = round2((p.deductions || []).reduce((s, d) => s + (num(d.amount) || 0), 0));
    const contract = byId(state.contracts, p.contractId);
    const retentionRate = contract ? Number(contract.retentionRate) || 0 : 0;
    const retention = round2((gross - deductions) * retentionRate);
    const net = round2(gross - deductions - retention);
    return { gross, deductions, retention, net };
  }

  /* ============================== 校验 ============================== */

  function fail(code, message, extra) {
    return { ok: false, code, message: ERR_PREFIX + message, ...(extra || {}) };
  }

  function requireRole(ctx, roles) {
    const role = ctx && ctx.role;
    if (!ROLES[role]) return fail("AUTH", "未知角色，无法操作");
    if (roles && roles.length && !roles.includes(role))
      return fail("FORBIDDEN", `当前角色「${ROLES[role].name}」无权执行此操作`);
    return null;
  }

  function validateCode(value, label) {
    if (value == null || String(value).trim() === "") return `${label}编号不能为空`;
    if (String(value).trim().length > 40) return `${label}编号过长（≤40 字符）`;
    if (/[\s<>"]/.test(String(value))) return `${label}编号含非法字符（空白 / < > "）`;
    return null;
  }

  function validateAmount(value, label, opts) {
    const n = num(value);
    if (Number.isNaN(n)) return `${label}必须是数字，收到：${String(value).slice(0, 20)}`;
    if ((opts || {}).nonNegative !== false && n < 0) return `${label}不能为负数`;
    if ((opts || {}).positive && n <= 0) return `${label}必须大于 0`;
    if (Math.abs(n) > 1e12) return `${label}超出允许范围`;
    return null;
  }

  function validateRate(value, label) {
    const n = num(value);
    if (Number.isNaN(n) || n < 0 || n > 1) return `${label}必须是 0~1 之间的比例（收到 ${String(value).slice(0, 20)}）`;
    return null;
  }

  function checkCodeUnique(state, code, exceptId) {
    code = String(code).trim();
    const pools = [state.vendors, state.contracts, state.reels, state.batches, state.defects, state.milestones, state.payments];
    for (const pool of pools) {
      const hit = pool.find((x) => x.code === code && x.id !== exceptId);
      if (hit) return `编号「${code}」已被${entityLabel(hit)}占用，编号必须全局唯一`;
    }
    return null;
  }

  function entityLabel(entity) {
    if (!entity) return "记录";
    const map = [
      ["vendorCode", "外包商"],
      ["contractNo", "合同"],
      ["reelCode", "胶片卷"],
      ["batchNo", "批次"],
      ["defectCode", "缺陷"],
      ["nodeCode", "付款节点"],
      ["payCode", "付款单"]
    ];
    for (const [k, v] of map) if (k in entity) return v;
    return "记录";
  }

  /* ============================== 审计 ============================== */

  function audit(state, entry) {
    state.audit = state.audit || [];
    state.audit.unshift(
      Object.assign(
        {
          id: uid("aud"),
          at: entry.at || new Date().toISOString(),
          actor: entry.actor || "未知",
          role: entry.role || "-",
          action: entry.action,
          target: entry.target || "",
          detail: entry.detail || "",
          result: entry.result || "ok",
          reason: entry.reason || "",
          version: entry.version != null ? entry.version : state.version
        },
        {}
      )
    );
    if (state.audit.length > 2000) state.audit.length = 2000;
  }

  function denied(state, ctx, action, reason, target) {
    audit(state, {
      actor: ctx.userName || ctx.role,
      role: ctx.role || "-",
      action,
      target: target || "",
      detail: reason,
      result: "denied",
      reason
    });
    return { state, events: [{ type: "denied", reason }], errors: [fail("DENIED", reason)] };
  }

  /* ============================== 动作 ============================== */

  const handlers = {};

  /* ---------- 基础档案：外包商 / 合同 / 胶片卷 ---------- */

  handlers.saveVendor = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm"]);
    if (g) return denied(state, ctx, "保存外包商", g.message, a.data.code);
    const d = a.data || {};
    const code = esc(d.code).trim();
    let msg = validateCode(code, "外包商");
    if (!msg && !esc(d.name).trim()) msg = "外包商名称不能为空";
    const existing = d.id ? byId(state.vendors, d.id) : byCode(state.vendors, code);
    if (!msg && !d.id && existing) msg = `外包商编号「${code}」重复`;
    if (msg) return denied(state, ctx, "保存外包商", msg, code);
    if (d.id && !existing) return denied(state, ctx, "保存外包商", "外包商不存在", code);
    const v = existing || { id: uid("ven"), code, createdAt: new Date().toISOString() };
    v.code = code;
    v.name = esc(d.name).trim();
    v.contact = esc(d.contact || "").trim();
    v.disabled = !!d.disabled;
    if (!existing) state.vendors.push(v);
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: existing ? "更新外包商" : "新增外包商", target: code });
    return { state, events: [{ type: "saved", kind: "vendor", id: v.id }], errors: [] };
  };

  handlers.saveContract = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm"]);
    if (g) return denied(state, ctx, "保存合同", g.message, a.data.code);
    const d = a.data || {};
    const code = esc(d.code).trim();
    let msg = validateCode(code, "合同");
    if (!msg) msg = validateAmount(d.budget, "合同预算", { positive: true });
    if (!msg) msg = validateAmount(d.unitPrice, "单帧价格", { positive: true });
    if (!msg) msg = validateRate(d.retentionRate, "保证金比例");
    if (!msg && !isValidDate(d.startDate)) msg = `合同开始日期非法（需 YYYY-MM-DD 真实日期，收到 ${esc(d.startDate)}）`;
    if (!msg && !isValidDate(d.endDate)) msg = `合同结束日期非法（收到 ${esc(d.endDate)}）`;
    if (!msg && d.startDate > d.endDate) msg = "合同开始日期不能晚于结束日期";
    if (!msg && d.vendorId && !byId(state.vendors, d.vendorId)) msg = "所选外包商不存在";
    if (!msg) msg = checkCodeUnique(state, code, d.id);
    if (msg) return denied(state, ctx, "保存合同", msg, code);
    const existing = d.id ? byId(state.contracts, d.id) : null;
    if (d.id && !existing) return denied(state, ctx, "保存合同", "合同不存在", code);
    // 已发生在途/已付款时，预算只能调高（防事后缩预算）
    if (existing) {
      const stats = contractStats(state, existing.id);
      if (Number(d.budget) < existing.budget && stats.committed > Number(d.budget))
        return denied(state, ctx, "保存合同", `预算不能调到低于在途金额 ${stats.committed}`, code);
    }
    const c = existing || { id: uid("con"), code, createdAt: new Date().toISOString() };
    c.code = code;
    c.name = esc(d.name || code).trim();
    c.vendorId = d.vendorId || "";
    c.budget = round2(num(d.budget));
    c.unitPrice = round2(num(d.unitPrice));
    c.retentionRate = round2(num(d.retentionRate));
    c.minPassRatio = d.minPassRatio == null || d.minPassRatio === "" ? 0 : num(d.minPassRatio);
    if (Number.isNaN(c.minPassRatio) || c.minPassRatio < 0 || c.minPassRatio > 1) c.minPassRatio = 0;
    c.startDate = d.startDate;
    c.endDate = d.endDate;
    if (!existing) state.contracts.push(c);
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: existing ? "更新合同" : "新增合同", target: code, detail: `预算 ${c.budget} / 保证金 ${(c.retentionRate * 100).toFixed(1)}%` });
    return { state, events: [{ type: "saved", kind: "contract", id: c.id }], errors: [] };
  };

  handlers.saveReel = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm", "qc"]);
    if (g) return denied(state, ctx, "保存胶片卷", g.message, a.data.code);
    const d = a.data || {};
    const code = esc(d.code).trim();
    let msg = validateCode(code, "胶片卷");
    if (!msg && !d.contractId) msg = "必须选择合同";
    if (!msg && d.contractId && !byId(state.contracts, d.contractId)) msg = "所选合同不存在";
    if (!msg) msg = validateAmount(d.totalFrames, "总画幅数", { positive: true });
    if (!msg && d.prevReelId && !byId(state.reels, d.prevReelId)) msg = "接续的上一卷不存在";
    if (!msg && d.prevReelId === d.id) msg = "胶片卷不能接续自身（自引用循环）";
    if (!msg) msg = checkCodeUnique(state, code, d.id);
    if (msg) return denied(state, ctx, "保存胶片卷", msg, code);

    const existing = d.id ? byId(state.reels, d.id) : null;
    if (d.id && !existing) return denied(state, ctx, "保存胶片卷", "胶片卷不存在", code);

    // 循环引用：以“保存后的边集”构图检测（新卷用临时节点，不落库）
    const edges = new Map();
    for (const r of state.reels) {
      if (existing && r.id === existing.id) continue; // 用新边替换
      edges.set(r.id, r.prevReelId ? [r.prevReelId] : []);
    }
    edges.set(existing ? existing.id : "__new_reel__", d.prevReelId ? [d.prevReelId] : []);
    const cyc = findAnyCycle(edges);
    if (cyc) {
      const hit = byId(state.reels, cyc);
      return denied(state, ctx, "保存胶片卷", `胶片卷接续关系存在循环引用（涉及 ${hit ? hit.code : "新卷"}）`, code);
    }

    const r = existing || { id: uid("rel"), code, createdAt: new Date().toISOString() };
    r.code = code;
    r.name = esc(d.name || code).trim();
    r.contractId = d.contractId;
    r.totalFrames = Math.round(num(d.totalFrames));
    r.prevReelId = d.prevReelId || "";
    if (!existing) state.reels.push(r);
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: existing ? "更新胶片卷" : "新增胶片卷", target: code });
    return { state, events: [{ type: "saved", kind: "reel", id: r.id }], errors: [] };
  };

  /* ---------- 扫描批次 ---------- */

  handlers.saveBatch = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm", "qc"]);
    if (g) return denied(state, ctx, "保存扫描批次", g.message, a.data.code);
    const d = a.data || {};
    const code = esc(d.code).trim();
    let msg = validateCode(code, "批次");
    if (!msg && !d.reelId) msg = "必须选择胶片卷";
    if (!msg && d.reelId && !byId(state.reels, d.reelId)) msg = "所选胶片卷不存在";
    if (!msg) msg = validateAmount(d.frames, "扫描画幅数", { positive: true });
    const reel = d.reelId ? byId(state.reels, d.reelId) : null;
    if (!msg && reel && num(d.frames) > Number(reel.totalFrames))
      msg = `扫描画幅数 ${num(d.frames)} 超过胶片卷总画幅 ${reel.totalFrames}`;
    if (!msg && d.scannedAt && !isValidDate(d.scannedAt)) msg = `扫描日期非法（收到 ${esc(d.scannedAt)}）`;
    if (!msg) msg = checkCodeUnique(state, code, d.id);
    if (msg) return denied(state, ctx, "保存扫描批次", msg, code);

    const existing = d.id ? byId(state.batches, d.id) : null;
    if (d.id && !existing) return denied(state, ctx, "保存扫描批次", "批次不存在", code);
    if (existing && (existing.status === "通过" || existing.status === "冻结") && ctx.role === "qc")
      return denied(state, ctx, "保存扫描批次", `批次已「${existing.status}」，质检员不能再改`, code);

    const b = existing || {
      id: uid("bat"),
      code,
      status: "待扫描",
      passedFrames: 0,
      createdAt: new Date().toISOString()
    };
    b.code = code;
    b.reelId = d.reelId;
    b.frames = Math.round(num(d.frames));
    b.scannedAt = d.scannedAt || today();
    b.operator = esc(d.operator || ctx.userName || ctx.role).trim();
    b.passedFrames = Math.min(b.passedFrames || 0, b.frames);
    if (!existing) state.batches.push(b);
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: existing ? "更新扫描批次" : "新增扫描批次", target: code, detail: `${b.frames} 画幅` });
    return { state, events: [{ type: "saved", kind: "batch", id: b.id }], errors: [] };
  };

  handlers.transitionBatch = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm", "qc"]);
    if (g) return denied(state, ctx, "批次流转", g.message, a.batchId);
    const b = byId(state.batches, a.batchId);
    if (!b) return denied(state, ctx, "批次流转", "批次不存在", a.batchId);
    const target = a.to;
    if (!BATCH_STATUSES.includes(target)) return denied(state, ctx, "批次流转", `非法目标状态「${target}」`, b.code);
    if (!BATCH_TRANSITIONS[b.status] || !BATCH_TRANSITIONS[b.status][target])
      return denied(state, ctx, "批次流转", `批次「${b.code}」不能从「${b.status}」流转到「${target}」`, b.code);

    // 关键缺陷约束：仍有未闭环关键缺陷的批次，不能判通过
    if (target === "通过") {
      const crit = openCriticalDefectIds(state, b.id);
      if (crit.length) {
        const codes = crit.map((id) => byId(state.defects, id).code).join("、");
        return denied(state, ctx, "批次判通过", `批次「${b.code}」存在未闭环关键缺陷：${codes}，须先返工闭环或冻结`, b.code);
      }
      if ((b.passedFrames || 0) <= 0)
        return denied(state, ctx, "批次判通过", `批次「${b.code}」合格画幅为 0，不能判通过（请先做验收记录）`, b.code);
    }
    // 冻结/解冻：只有 pm/admin
    if ((target === "冻结" || b.status === "冻结") && !["pm", "admin"].includes(ctx.role))
      return denied(state, ctx, "批次流转", "只有项目经理/管理员可以冻结或解冻批次", b.code);

    const from = b.status;
    b.status = target;
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: "批次流转", target: b.code, detail: `${from} → ${target}` });
    return { state, events: [{ type: "transitioned", id: b.id, to: target }], errors: [] };
  };

  /** 验收登记：记录合格画幅，可同时登记缺陷；部分通过时批次可判「通过」但按合格画幅计价 */
  handlers.acceptBatch = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm", "qc"]);
    if (g) return denied(state, ctx, "批次验收", g.message, a.batchId);
    const b = byId(state.batches, a.batchId);
    if (!b) return denied(state, ctx, "批次验收", "批次不在", a.batchId);
    if (b.status !== "验收") return denied(state, ctx, "批次验收", `批次「${b.code}」当前为「${b.status}」，需先转入验收`, b.code);
    const passed = Math.round(num(a.passedFrames));
    if (Number.isNaN(passed) || passed < 0) return denied(state, ctx, "批次验收", "合格画幅数非法", b.code);
    if (passed > b.frames) return denied(state, ctx, "批次验收", `合格画幅 ${passed} 超过扫描画幅 ${b.frames}`, b.code);

    b.passedFrames = passed;
    b.acceptedAt = today();
    b.acceptedBy = ctx.userName || ctx.role;
    let addedDefects = [];
    for (const d of a.defects || []) {
      const sev = d.severity;
      if (!DEFECT_SEVERITIES.includes(sev)) return denied(state, ctx, "批次验收", `缺陷等级非法：${sev}`, b.code);
      const code = esc(d.code || `D-${b.code}-${state.defects.length + 1}`).trim();
      if (byCode(state.defects, code)) return denied(state, ctx, "批次验收", `缺陷编号「${code}」重复`, b.code);
      const rec = {
        id: uid("def"),
        code,
        batchId: b.id,
        severity: sev,
        type: esc(d.type || "其他").trim(),
        description: esc(d.description || "").trim(),
        status: sev === SEVERITY_CRITICAL ? "待整改" : "待整改",
        createdAt: new Date().toISOString(),
        createdBy: ctx.userName || ctx.role
      };
      state.defects.push(rec);
      addedDefects.push(rec);
    }
    const ratio = ((passed / (b.frames || 1)) * 100).toFixed(1);
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: "验收登记", target: b.code, detail: `合格 ${passed}/${b.frames}（${ratio}%），缺陷 ${addedDefects.length} 条` });
    return { state, events: [{ type: "accepted", id: b.id, passedFrames: passed, defects: addedDefects }], errors: [] };
  };

  /* ---------- 质检缺陷 ---------- */

  handlers.saveDefect = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm", "qc"]);
    if (g) return denied(state, ctx, "保存缺陷", g.message, a.data.code);
    const d = a.data || {};
    const code = esc(d.code).trim();
    let msg = validateCode(code, "缺陷");
    if (!msg && !d.batchId) msg = "必须指定批次";
    if (!msg && !byId(state.batches, d.batchId)) msg = "所属批次不存在";
    if (!msg && !DEFECT_SEVERITIES.includes(d.severity)) msg = `缺陷等级非法：${esc(d.severity)}`;
    if (!msg && d.status && !DEFECT_STATUS.includes(d.status)) msg = `缺陷状态非法：${esc(d.status)}`;
    if (!msg) msg = checkCodeUnique(state, code, d.id);
    if (msg) return denied(state, ctx, "保存缺陷", msg, code);
    const existing = d.id ? byId(state.defects, d.id) : null;
    if (d.id && !existing) return denied(state, ctx, "保存缺陷", "缺陷不存在", code);
    const rec = existing || { id: uid("def"), code, createdAt: new Date().toISOString() };
    const oldStatus = rec.status;
    rec.code = code;
    rec.batchId = d.batchId;
    rec.severity = d.severity;
    rec.type = esc(d.type || "其他").trim();
    rec.description = esc(d.description || "").trim();
    rec.status = d.status || "待整改";
    try {
      rec.thumb = validateThumbData(d.thumb, rec.thumb);
    } catch (e) {
      return denied(state, ctx, "保存缺陷", e.message, code);
    }
    if (!existing) state.defects.push(rec);
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: existing ? "更新缺陷" : "登记缺陷", target: code, detail: `${rec.severity}/${rec.type}${oldStatus && oldStatus !== rec.status ? `：${oldStatus}→${rec.status}` : ""}` });
    return { state, events: [{ type: "saved", kind: "defect", id: rec.id }], errors: [] };
  };

  /** 缩略图安全：只接受 image/png|jpeg|gif|webp 的 data:URL，并按魔数校验内容；拦伪装文件与 SVG */
  function validateThumbData(value, previous) {
    if (value == null) return previous || "";
    if (value === "") return "";
    const m = /^data:([^;,]+)(;base64)?,/.exec(String(value));
    if (!m) return previous || ""; // 非 data URL，忽略而不炸
    const mime = m[1].toLowerCase();
    const b64 = String(value).slice(m[0].length);
    const allowed = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };
    if (!allowed[mime]) throw new ValidationError(`缩略图 MIME 不允许：${mime}（SVG/脚本内容一律拒绝）`);
    let bytes;
    try {
      bytes = base64ToBytes(b64);
    } catch {
      throw new ValidationError("缩略图 base64 解码失败，文件可能已损坏或伪装");
    }
    if (bytes.length < 12) throw new ValidationError("缩略图数据过短，疑似伪装文件");
    if (bytes.length > 512 * 1024) throw new ValidationError("缩略图大于 500KB，请压缩后上传");
    const sig = signatureOf(bytes);
    const expect = {
      "image/png": "89504e470d0a1a0a",
      "image/jpeg": "ffd8ff",
      "image/gif": "47494638",
      "image/webp": "52494646" // RIFF....WEBP 另查
    };
    if (!sig.startsWith(expect[mime])) throw new ValidationError(`文件内容（${sig.slice(0, 8)}）与声称的类型 ${mime} 不符，疑似伪装缩略图`);
    if (mime === "image/webp" && !(bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50))
      throw new ValidationError("伪装的 WEBP：缺少 WEBP 标记");
    return String(value);
  }

  function ValidationError(message) {
    this.name = "ValidationError";
    this.message = message;
  }
  ValidationError.prototype = new Error();

  handlers.transitionDefect = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm", "qc"]);
    if (g) return denied(state, ctx, "缺陷流转", g.message, a.defectId);
    const d = byId(state.defects, a.defectId);
    if (!d) return denied(state, ctx, "缺陷流转", "缺陷不存在", a.defectId);
    const flow = { 待整改: ["已返工待复验"], 已返工待复验: ["闭环", "待整改"], 闭环: ["待整改"] };
    if (!(flow[d.status] || []).includes(a.to))
      return denied(state, ctx, "缺陷流转", `缺陷「${d.code}」不能从「${d.status}」变为「${a.to}」`, d.code);
    if (a.to === "闭环" && d.severity === SEVERITY_CRITICAL && ctx.role === "qc" && false) {
      // 关键缺陷允许质检员闭环（复验通过），此处保留扩展点
    }
    const from = d.status;
    d.status = a.to;
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: "缺陷流转", target: d.code, detail: `${from} → ${a.to}` });
    // 缺陷闭环/重开可能影响批次可付款性，事件通知 UI 重算
    return { state, events: [{ type: "defectTransitioned", id: d.id, to: a.to }], errors: [] };
  };

  /* ---------- 付款节点 ---------- */

  handlers.saveMilestone = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm"]);
    if (g) return denied(state, ctx, "保存付款节点", g.message, a.data.code);
    const d = a.data || {};
    const code = esc(d.code).trim();
    let msg = validateCode(code, "付款节点");
    if (!msg && !d.contractId) msg = "必须选择合同";
    if (!msg && !byId(state.contracts, d.contractId)) msg = "所属合同不存在";
    if (!msg) msg = validateAmount(d.amount, "节点金额", { positive: true });
    if (!msg && d.dueDate && !isValidDate(d.dueDate)) msg = `节点日期非法（收到 ${esc(d.dueDate)}）`;
    if (!msg) msg = checkCodeUnique(state, code, d.id);
    if (msg) return denied(state, ctx, "保存付款节点", msg, code);

    const existing = d.id ? byId(state.milestones, d.id) : null;
    if (d.id && !existing) return denied(state, ctx, "保存付款节点", "付款节点不存在", code);

    // 前置节点循环检测
    const prereq = Array.isArray(d.prereqIds) ? d.prereqIds.filter((x) => x) : [];
    for (const pid of prereq) {
      if (!byId(state.milestones, pid)) return denied(state, ctx, "保存付款节点", "前置付款节点不存在", code);
      if (existing && pid === existing.id) return denied(state, ctx, "保存付款节点", "付款节点不能前置自身（自引用循环）", code);
    }
    const edges = new Map();
    for (const m of state.milestones) {
      if (existing && m.id === existing.id) continue;
      edges.set(m.id, m.prereqIds || []);
    }
    edges.set(existing ? existing.id : "__new_ms__", prereq);
    const cyc = findAnyCycle(edges);
    if (cyc) {
      const hit = byId(state.milestones, cyc);
      return denied(state, ctx, "保存付款节点", `付款节点前置关系存在循环引用（涉及 ${hit ? hit.code : "新节点"}）`, code);
    }

    const m = existing || { id: uid("ms"), code, createdAt: new Date().toISOString() };
    m.code = code;
    m.name = esc(d.name || code).trim();
    m.contractId = d.contractId;
    m.amount = round2(num(d.amount));
    m.dueDate = d.dueDate || "";
    m.prereqIds = prereq;
    if (!existing) state.milestones.push(m);
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: existing ? "更新付款节点" : "新增付款节点", target: code, detail: `金额 ${m.amount}` });
    return { state, events: [{ type: "saved", kind: "milestone", id: m.id }], errors: [] };
  };

  /* ---------- 付款单 ---------- */

  function validatePaymentState(state, p, opts) {
    // 返回错误字符串数组（空数组 = 通过）
    const errs = [];
    const contract = byId(state.contracts, p.contractId);
    if (!contract) { errs.push("所选合同不存在"); return errs; }
    if (!p.batchIds || !p.batchIds.length) errs.push("至少选择一个验收通过的批次");

    const batches = (p.batchIds || []).map((id) => byId(state.batches, id)).filter(Boolean);
    for (const b of batches) {
      const reel = byId(state.reels, b.reelId);
      if (!reel || reel.contractId !== contract.id) errs.push(`批次「${b.code}」不属于所选合同`);
      if (b.status !== "通过") errs.push(`批次「${b.code}」状态为「${b.status}」，只有通过批次可付款`);
      const crit = openCriticalDefectIds(state, b.id);
      if (crit.length) {
        const codes = crit.map((id) => byId(state.defects, id).code).join("、");
        errs.push(`批次「${b.code}」存在未闭环关键缺陷：${codes}（关键缺陷不得进入付款）`);
      }
      if (batchAcceptedFrames(b) <= 0) errs.push(`批次「${b.code}」合格画幅为 0`);
    }

    // 重复付款：同批次不能被另一张在途/已付付款单占用
    const duplicateBatches = [];
    for (const b of batches) {
      const clash = state.payments.find(
        (q) => q.id !== p.id &&
          ["草稿", "待审批", "审批中", "已批准", "已付款"].includes(q.status) &&
          (q.batchIds || []).includes(b.id)
      );
      if (clash) duplicateBatches.push(`${b.code}（已在付款单 ${clash.code} 中）`);
    }
    if (duplicateBatches.length) errs.push(`重复付款：${duplicateBatches.join("、")}`);

    // 扣款
    for (const d of p.deductions || []) {
      const n = num(d.amount);
      if (Number.isNaN(n) || n < 0) errs.push(`扣款「${esc(d.reason) || "未命名"}」金额非法（${esc(d.amount)}）`);
    }

    const amounts = computePaymentAmounts(state, p);
    if (amounts.net < 0) errs.push(`扣款+保证金超过产值，应付 ${amounts.net} 为负`);
    p._amounts = amounts;

    // 合同预算（按 gross 占用）
    const stats = contractStats(state, contract.id);
    const otherCommitted = state.payments
      .filter((q) => q.id !== p.id && ["待审批", "审批中", "已批准", "已付款"].includes(q.status) && q.contractId === contract.id)
      .reduce((s, q) => s + Number(q.gross || 0), 0);
    if (opts && opts.commit) {
      if (round2(otherCommitted + amounts.gross) > Number(contract.budget) + 0.001)
        errs.push(`超付：合同预算 ${contract.budget}，已有在途 ${round2(otherCommitted)}，本单产值 ${amounts.gross}，合计超出 ${round2(otherCommitted + amounts.gross - contract.budget)}`);
    }

    // 付款节点金额上限 + 前置节点
    if (p.milestoneId) {
      const ms = milestoneStats(state, p.milestoneId);
      if (!ms) errs.push("所选付款节点不存在");
      else {
        const otherMs = state.payments
          .filter((q) => q.id !== p.id && ["待审批", "审批中", "已批准", "已付款"].includes(q.status) && q.milestoneId === p.milestoneId)
          .reduce((s, q) => s + Number(q.gross || 0), 0);
        if (opts && opts.commit && round2(otherMs + amounts.gross) > Number(ms.milestone.amount) + 0.001)
          errs.push(`超付：付款节点「${ms.milestone.code}」额度 ${ms.milestone.amount}，本单将超出 ${round2(otherMs + amounts.gross - ms.milestone.amount)}`);
        for (const pre of ms.milestone.prereqIds || []) {
          const prePaid = state.payments.some((q) => q.milestoneId === pre && q.status === "已付款");
          if (!prePaid) errs.push(`前置付款节点「${byId(state.milestones, pre).code}」尚未付款`);
        }
      }
    }

    // 验收比例
    const minRatio = Number(contract.minPassRatio) || 0;
    if (minRatio > 0) {
      const ratio = stats.passRatio;
      if (ratio + 1e-9 < minRatio)
        errs.push(`验收比例不足：合同要求合格占比 ≥ ${(minRatio * 100).toFixed(1)}%，当前 ${(ratio * 100).toFixed(1)}%`);
    }
    return errs;
  }

  handlers.savePayment = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm", "finance"]);
    if (g) return denied(state, ctx, "保存付款单", g.message, a.data && a.data.code);
    const d = a.data || {};
    if (ctx.role !== "admin") {
      const cap = ROLES[ctx.role].limits.paymentCreate;
      const tentativeNet = num(d.tentativeNet);
      if (!Number.isNaN(tentativeNet) && tentativeNet > cap)
        return denied(state, ctx, "保存付款单", `越权：${ROLES[ctx.role].name}只能发起 ≤ ${cap} 的付款单，本单约 ${tentativeNet}`, d.code);
    }
    const code = esc(d.code).trim();
    let msg = validateCode(code, "付款单");
    if (!msg && !d.contractId) msg = "必须选择合同";
    if (!msg && d.milestoneId === "") msg = undefined;
    if (msg) return denied(state, ctx, "保存付款单", msg, code);

    const existing = d.id ? byId(state.payments, d.id) : null;
    if (d.id && !existing) return denied(state, ctx, "保存付款单", "付款单不存在", code);
    if (existing && ["已付款", "审批中", "待审批"].includes(existing.status) && a.submit)
      return denied(state, ctx, "提交付款单", `付款单「${code}」已处于 ${existing.status}，请勿重复提交`, code);

    const p = existing || {
      id: uid("pay"),
      code,
      status: "草稿",
      createdAt: new Date().toISOString(),
      approvals: [],
      batchIds: [],
      deductions: []
    };
    p.code = code;
    p.contractId = d.contractId;
    p.milestoneId = d.milestoneId || "";
    p.batchIds = Array.isArray(d.batchIds) ? [...new Set(d.batchIds)] : [];
    p.deductions = Array.isArray(d.deductions)
      ? d.deductions.map((x) => ({ reason: esc(x.reason || "扣款").trim(), amount: round2(num(x.amount) || 0) }))
      : [];
    p.note = esc(d.note || "").trim();

    // 保存草稿：只做结构校验，不强制预算/比例（允许暂存）
    const draftErrs = validatePaymentState(state, p, { commit: false });
    if (draftErrs.length) return denied(state, ctx, existing ? "更新付款单" : "新增付款单", draftErrs.join("；"), code);

    const amounts = p._amounts;
    delete p._amounts;
    p.gross = amounts.gross;
    p.deductionsTotal = amounts.deductions;
    p.retention = amounts.retention;
    p.net = amounts.net;
    if (!existing) state.payments.push(p);

    if (a.submit) {
      const submitErrs = validatePaymentState(state, p, { commit: true });
      if (submitErrs.length) return denied(state, ctx, "提交付款单", submitErrs.join("；"), code);
      p.status = "待审批";
      p.submittedAt = new Date().toISOString();
      p.submittedBy = ctx.userName || ctx.role;
      p.requiredLevel = requiredLevelFor(p.net);
      audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: "提交付款单", target: code, detail: `应付 ${p.net}（产值 ${p.gross}，扣款 ${p.deductionsTotal}，保证金扣留 ${p.retention}），需审批级别 ${p.requiredLevel}` });
    } else {
      audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: existing ? "更新付款单草稿" : "保存付款单草稿", target: code, detail: `应付 ${p.net}` });
    }
    return { state, events: [{ type: "saved", kind: "payment", id: p.id, status: p.status }], errors: [] };
  };

  handlers.approvePayment = function (state, a, ctx) {
    const g = requireRole(ctx, ["pm", "finance", "director", "admin"]);
    if (g) return denied(state, ctx, "审批付款", g.message, a.paymentId);
    const p = byId(state.payments, a.paymentId);
    if (!p) return denied(state, ctx, "审批付款", "付款单不存在", a.paymentId);
    if (ctx.role === "admin") return denied(state, ctx, "审批付款", "管理员不能参与审批（职责分离）", p.code);
    if (!["待审批", "审批中"].includes(p.status))
      return denied(state, ctx, "审批付款", `付款单「${p.code}」状态为「${p.status}」，不能审批`, p.code);

    const role = ROLES[ctx.role];
    // 金额阈值只用于决定“需要几级”；各级按顺序签署，终审级别由 requiredLevel 保证额度足够
    const step = APPROVAL_STEPS.find((s) => s.role === ctx.role);
    if (!step) return denied(state, ctx, "审批付款", "当前角色不是审批角色", p.code);

    // 不能自审
    if (p.submittedBy && (p.submittedBy === (ctx.userName || ctx.role)))
      return denied(state, ctx, "审批付款", "提交人不能审批自己发起的付款单（职责分离）", p.code);

    // 顺序审批：必须按级别 1→2→3
    const doneLevels = new Set(p.approvals.map((x) => x.level));
    const expectedLevel = doneLevels.size + 1;
    if (step.level !== expectedLevel)
      return denied(state, ctx, "审批付款", `审批顺序错误：当前需要级别 ${expectedLevel}（${(APPROVAL_STEPS.find((s) => s.level === expectedLevel) || {}).label || "?"}），不能由级别 ${step.level} 越级审批`, p.code);
    if (doneLevels.has(step.level))
      return denied(state, ctx, "审批付款", "该级别已审批，禁止重复审批", p.code);

    // 提交后到审批前，数据可能已变化：重新校验硬约束
    const recheck = validatePaymentState(state, p, { commit: true });
    if (recheck.length) return denied(state, ctx, "审批付款", `审批前复核失败：${recheck.join("；")}`, p.code);
    const amounts = p._amounts;
    delete p._amounts;
    if (amounts) {
      p.gross = amounts.gross;
      p.deductionsTotal = amounts.deductions;
      p.retention = amounts.retention;
      p.net = amounts.net;
    }
    const needLevel = p.requiredLevel || requiredLevelFor(p.net);
    if (step.level > needLevel)
      return denied(state, ctx, "审批付款", `审批级别超出需要：本单仅需级别 ${needLevel}`, p.code);

    p.approvals.push({ level: step.level, role: ctx.role, by: ctx.userName || ctx.role, at: new Date().toISOString(), comment: esc(a.comment || "") });
    p.status = step.level >= needLevel ? "已批准" : "审批中";
    audit(state, {
      actor: ctx.userName || ctx.role,
      role: ctx.role,
      action: "审批通过",
      target: p.code,
      detail: `${step.label}（级别 ${step.level}/${needLevel}）${p.status === "已批准" ? "，审批完成" : ""}`
    });
    return { state, events: [{ type: "approved", id: p.id, status: p.status }], errors: [] };
  };

  handlers.rejectPayment = function (state, a, ctx) {
    const g = requireRole(ctx, ["pm", "finance", "director"]);
    if (g) return denied(state, ctx, "驳回付款", g.message, a.paymentId);
    const p = byId(state.payments, a.paymentId);
    if (!p) return denied(state, ctx, "驳回付款", "付款单不存在", a.paymentId);
    if (!["待审批", "审批中"].includes(p.status))
      return denied(state, ctx, "驳回付款", `付款单「${p.code}」状态为「${p.status}」，不能驳回`, p.code);
    p.status = "驳回";
    p.rejectedAt = new Date().toISOString();
    p.rejectedBy = ctx.userName || ctx.role;
    p.rejectReason = esc(a.reason || "未说明").trim();
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: "驳回付款", target: p.code, detail: p.rejectReason });
    return { state, events: [{ type: "rejected", id: p.id }], errors: [] };
  };

  handlers.payPayment = function (state, a, ctx) {
    const g = requireRole(ctx, ["finance", "admin"]);
    if (g) return denied(state, ctx, "付款确认", g.message, a.paymentId);
    if (ctx.role === "admin") return denied(state, ctx, "付款确认", "管理员不能直接确认付款", a.paymentId);
    const p = byId(state.payments, a.paymentId);
    if (!p) return denied(state, ctx, "付款确认", "付款单不存在", a.paymentId);
    if (p.status !== "已批准")
      return denied(state, ctx, "付款确认", `付款单「${p.code}」未完成审批（${p.status}），不能付款`, p.code);
    // 付款前最终硬校验（防批准后批次被改/缺陷重开）
    const finalCheck = validatePaymentState(state, p, { commit: true });
    if (finalCheck.length) return denied(state, ctx, "付款确认", `付款前终检失败：${finalCheck.join("；")}`, p.code);
    delete p._amounts;
    const serial = esc(a.serial || `PAY-${String(state.payments.filter((q) => q.status === "已付款").length + 1).padStart(4, "0")}`).trim();
    if (state.payments.some((q) => q.serial === serial))
      return denied(state, ctx, "付款确认", `付款流水号「${serial}」重复`, p.code);
    p.status = "已付款";
    p.paidAt = new Date().toISOString();
    p.paidBy = ctx.userName || ctx.role;
    p.serial = serial;
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: "付款确认", target: p.code, detail: `${p.serial} 实付 ${p.net}` });
    return { state, events: [{ type: "paid", id: p.id, serial: p.serial }], errors: [] };
  };

  /* ---------- 删除（仅草稿/无关联） ---------- */

  handlers.deleteEntity = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm"]);
    if (g) return denied(state, ctx, "删除记录", g.message, a.target);
    const map = {
      vendor: state.vendors,
      contract: state.contracts,
      reel: state.reels,
      batch: state.batches,
      defect: state.defects,
      milestone: state.milestones,
      payment: state.payments
    };
    const pool = map[a.kind];
    if (!pool) return denied(state, ctx, "删除记录", `未知类型 ${a.kind}`, a.id);
    const idx = pool.findIndex((x) => x.id === a.id);
    if (idx < 0) return denied(state, ctx, "删除记录", "记录不存在", a.id);
    const rec = pool[idx];
    // 引用保护
    const refs = [];
    if (a.kind === "vendor") state.contracts.forEach((c) => c.vendorId === rec.id && refs.push(`合同 ${c.code}`));
    if (a.kind === "contract") {
      state.reels.forEach((r) => r.contractId === rec.id && refs.push(`胶片卷 ${r.code}`));
      state.milestones.forEach((m) => m.contractId === rec.id && refs.push(`付款节点 ${m.code}`));
    }
    if (a.kind === "reel") state.batches.forEach((b) => b.reelId === rec.id && refs.push(`批次 ${b.code}`));
    if (a.kind === "batch") state.defects.forEach((d) => d.batchId === rec.id && refs.push(`缺陷 ${d.code}`));
    if (a.kind === "payment" && !["草稿", "驳回"].includes(rec.status))
      return denied(state, ctx, "删除记录", `付款单「${rec.code}」状态为 ${rec.status}，不能删除`, rec.code);
    if (refs.length) return denied(state, ctx, "删除记录", `「${rec.code}」被 ${refs.slice(0, 3).join("、")} 引用，不能删除`, rec.code);
    pool.splice(idx, 1);
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: "删除记录", target: rec.code, detail: a.kind });
    return { state, events: [{ type: "deleted", kind: a.kind, id: a.id }], errors: [] };
  };

  /* ============================== 导入 ============================== */

  /**
   * 校验并合并导入包。全有或全无：任何一条错误则整体拒绝。
   * payload: { vendors:[], contracts:[], reels:[], batches:[], defects:[], milestones:[] }
   */
  function validateImport(state, payload, ctx) {
    const errors = [];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return ["导入包必须是 JSON 对象，例如 {\"vendors\":[...], ...}"];
    }
    const known = ["vendors", "contracts", "reels", "batches", "defects", "milestones"];
    for (const k of Object.keys(payload)) {
      if (!known.includes(k)) {
        // 越权记录：禁止夹带付款单/审批/审计/用户等（整包仍会被拒绝，继续收集其他错误）
        if (["payments", "approvals", "audit", "auditLog", "users", "roles", "sessions"].includes(k))
          errors.push(`越权记录：导入包不允许包含「${k}」，付款/审批/审计只能在系统内产生`);
        else errors.push(`未知顶层字段「${k}」，已忽略（允许字段：${known.join("/")}）`);
      }
    }

    const bags = {};
    for (const k of known) bags[k] = Array.isArray(payload[k]) ? payload[k] : [];

    // 1) 逐条字段校验 + 包内重复编号 + 跨类型撞号（同类型同编号视为更新，允许）
    const seenCodes = new Set();
    const poolByKind = { vendors: state.vendors, contracts: state.contracts, reels: state.reels, batches: state.batches, defects: state.defects, milestones: state.milestones };
    const checkLine = (kind, i, fn) => {
      const msgs = fn();
      for (const m of [].concat(msgs || [])) if (m) errors.push(`[${kind} #${i + 1}] ${m}`);
    };
    const dupCheck = (kind, i, code, poolKey, kindLabel) => {
      if (!code) return;
      if (seenCodes.has(code)) errors.push(`[${kind} #${i + 1}] 重复编号「${code}」（导入包内重复）`);
      seenCodes.add(code);
      // 库内同编号：同类型=更新允许；不同类型=全局唯一冲突
      for (const [pk, pool] of Object.entries(poolByKind)) {
        if (pool.some((x) => x.code === code) && pk !== poolKey) {
          errors.push(`[${kind} #${i + 1}] 编号「${code}」已被其他类型记录占用，${kindLabel}编号必须全局唯一`);
        }
      }
    };

    bags.vendors.forEach((v, i) => checkLine("外包商", i, () => {
      if (!v || typeof v !== "object") return "记录必须是对象";
      const e = [validateCode(v.code, "外包商"), !esc(v.name).trim() ? "名称不能为空" : null];
      dupCheck("外包商", i, esc(v.code).trim(), "vendors", "外包商");
      return e.filter(Boolean);
    }));

    bags.contracts.forEach((c, i) => checkLine("合同", i, () => {
      if (!c || typeof c !== "object") return "记录必须是对象";
      const e = [
        validateCode(c.code, "合同"),
        validateAmount(c.budget, "预算", { positive: true }),
        validateAmount(c.unitPrice, "单帧价格", { positive: true }),
        c.retentionRate == null ? null : validateRate(c.retentionRate, "保证金比例"),
        c.minPassRatio == null ? null : validateRate(c.minPassRatio, "最低验收比例"),
        !isValidDate(c.startDate) ? `开始日期非法（需 YYYY-MM-DD，收到 ${esc(c.startDate)}）` : null,
        !isValidDate(c.endDate) ? `结束日期非法（收到 ${esc(c.endDate)}）` : null,
        c.startDate && c.endDate && c.startDate > c.endDate ? "开始日期晚于结束日期" : null
      ];
      dupCheck("合同", i, esc(c.code).trim(), "contracts", "合同");
      return e.filter(Boolean);
    }));

    bags.reels.forEach((r, i) => checkLine("胶片卷", i, () => {
      if (!r || typeof r !== "object") return "记录必须是对象";
      const e = [
        validateCode(r.code, "胶片卷"),
        validateAmount(r.totalFrames, "总画幅数", { positive: true })
      ];
      dupCheck("胶片卷", i, esc(r.code).trim(), "reels", "胶片卷");
      return e.filter(Boolean);
    }));

    bags.batches.forEach((b, i) => checkLine("批次", i, () => {
      if (!b || typeof b !== "object") return "记录必须是对象";
      const e = [
        validateCode(b.code, "批次"),
        validateAmount(b.frames, "扫描画幅数", { positive: true }),
        b.scannedAt && !isValidDate(b.scannedAt) ? `扫描日期非法（收到 ${esc(b.scannedAt)}）` : null,
        b.status && !BATCH_STATUSES.includes(b.status) ? `批次状态非法：${esc(b.status)}` : null
      ];
      dupCheck("批次", i, esc(b.code).trim(), "batches", "批次");
      return e.filter(Boolean);
    }));

    bags.defects.forEach((d, i) => checkLine("缺陷", i, () => {
      if (!d || typeof d !== "object") return "记录必须是对象";
      const e = [
        validateCode(d.code, "缺陷"),
        !DEFECT_SEVERITIES.includes(d.severity) ? `缺陷等级非法：${esc(d.severity)}` : null
      ];
      dupCheck("缺陷", i, esc(d.code).trim(), "defects", "缺陷");
      if (d.thumb) {
        try { validateThumbData(d.thumb, ""); }
        catch (err) { e.push(`缩略图问题：${err.message}`); }
      }
      return e.filter(Boolean);
    }));

    bags.milestones.forEach((m, i) => checkLine("付款节点", i, () => {
      if (!m || typeof m !== "object") return "记录必须是对象";
      const e = [
        validateCode(m.code, "付款节点"),
        validateAmount(m.amount, "节点金额", { positive: true }),
        m.dueDate && !isValidDate(m.dueDate) ? `节点日期非法（收到 ${esc(m.dueDate)}）` : null
      ];
      dupCheck("付款节点", i, esc(m.code).trim(), "milestones", "付款节点");
      return e.filter(Boolean);
    }));

    // 2) 引用解析（支持 code 引用；引用校验与编号重复相互独立，始终执行）
    {
      const vendorByCode = new Map([...state.vendors.map((v) => [v.code, v]), ...bags.vendors.map((v) => [v.code, { __new: true, code: v.code }])]);
      const contractByCode = new Map([...state.contracts.map((c) => [c.code, c]), ...bags.contracts.map((c) => [c.code, { __new: true, code: c.code }])]);
      const reelByCode = new Map([...state.reels.map((r) => [r.code, r]), ...bags.reels.map((r) => [r.code, { __new: true, code: r.code }])]);
      const batchByCode = new Map([...state.batches.map((b) => [b.code, b]), ...bags.batches.map((b) => [b.code, { __new: true, code: b.code }])]);

      bags.contracts.forEach((c, i) => {
        if (c.vendorCode && !vendorByCode.has(c.vendorCode)) errors.push(`[合同 #${i + 1}] 引用的外包商「${c.vendorCode}」不存在`);
      });
      bags.reels.forEach((r, i) => {
        if (!r.contractCode) errors.push(`[胶片卷 #${i + 1}] 缺少 contractCode`);
        else if (!contractByCode.has(r.contractCode)) errors.push(`[胶片卷 #${i + 1}] 引用的合同「${r.contractCode}」不存在`);
        if (r.prevReelCode && !reelByCode.has(r.prevReelCode)) errors.push(`[胶片卷 #${i + 1}] 接续的上一卷「${r.prevReelCode}」不存在`);
        if (r.prevReelCode === r.code) errors.push(`[胶片卷 #${i + 1}] 不能接续自身`);
      });
      bags.batches.forEach((b, i) => {
        if (!b.reelCode) errors.push(`[批次 #${i + 1}] 缺少 reelCode`);
        else if (!reelByCode.has(b.reelCode)) errors.push(`[批次 #${i + 1}] 引用的胶片卷「${b.reelCode}」不存在`);
        const reel = b.reelCode && reelByCode.get(b.reelCode);
        if (reel && num(b.frames)) {
          const tf = reel.__new ? num(bags.reels.find((x) => x.code === reel.code).totalFrames) : reel.totalFrames;
          if (num(b.frames) > tf) errors.push(`[批次 #${i + 1}] 画幅 ${num(b.frames)} 超过胶片卷「${reel.code}」总画幅 ${tf}`);
        }
      });
      bags.defects.forEach((d, i) => {
        if (!d.batchCode) errors.push(`[缺陷 #${i + 1}] 缺少 batchCode`);
        else if (!batchByCode.has(d.batchCode)) errors.push(`[缺陷 #${i + 1}] 引用的批次「${d.batchCode}」不存在`);
      });
      bags.milestones.forEach((m, i) => {
        if (!m.contractCode) errors.push(`[付款节点 #${i + 1}] 缺少 contractCode`);
        else if (!contractByCode.has(m.contractCode)) errors.push(`[付款节点 #${i + 1}] 引用的合同「${m.contractCode}」不存在`);
        const pre = m.prereqCodes || [];
        if (!Array.isArray(pre)) errors.push(`[付款节点 #${i + 1}] prereqCodes 必须是数组`);
        else pre.forEach((pc) => {
          if (!state.milestones.some((x) => x.code === pc) && !bags.milestones.some((x) => x.code === pc))
            errors.push(`[付款节点 #${i + 1}] 前置节点「${pc}」不存在`);
          if (pc === m.code) errors.push(`[付款节点 #${i + 1}] 不能前置自身`);
        });
      });

      // 3) 循环引用（把包内边与库内边合并检测；即使已有其他错误也检测，便于一次看全）
      {
        // 胶片卷接续图
        const reelEdges = new Map();
        for (const r of state.reels) reelEdges.set(r.code, r.prevReelId ? [byId(state.reels, r.prevReelId).code] : []);
        for (const r of bags.reels) reelEdges.set(r.code, r.prevReelCode ? [r.prevReelCode] : reelEdges.get(r.code) || []);
        const c1 = findAnyCycle(reelEdges);
        if (c1) errors.push(`循环引用：胶片卷接续链在「${c1}」处成环`);
        // 节点前置图
        const msEdges = new Map();
        for (const m of state.milestones) msEdges.set(m.code, (m.prereqIds || []).map((id) => byId(state.milestones, id).code));
        for (const m of bags.milestones) {
          const preCodes = (m.prereqCodes || []).map((pc) =>
            state.milestones.some((x) => x.code === pc) ? byId(state.milestones, state.milestones.find((x) => x.code === pc).id).code : pc
          );
          msEdges.set(m.code, preCodes);
        }
        const c2 = findAnyCycle(msEdges);
        if (c2) errors.push(`循环引用：付款节点前置关系在「${c2}」处成环`);
      }
    }
    return errors;
  }

  handlers.importBundle = function (state, a, ctx) {
    const g = requireRole(ctx, ["admin", "pm"]);
    if (g) return denied(state, ctx, "导入", g.message, "");
    let payload;
    try {
      payload = typeof a.payload === "string" ? JSON.parse(a.payload) : a.payload;
    } catch (e) {
      return denied(state, ctx, "导入", `JSON 解析失败：${e.message}`, "");
    }
    const errors = validateImport(state, payload, ctx);
    if (errors.length) return denied(state, ctx, "导入", `导入被整体拒绝（${errors.length} 个问题）：${errors.slice(0, 5).join("；")}${errors.length > 5 ? ` 等 ${errors.length} 条` : ""}`, "");

    // 合并：两轮。第一轮按 code upsert 全部记录（壳），第二轮解析引用（支持任意顺序/后置引用）。
    const counts = { vendors: 0, contracts: 0, reels: 0, batches: 0, defects: 0, milestones: 0 };
    const upsert = (pool, code, make) => {
      let rec = byCode(pool, code);
      if (!rec) {
        rec = make();
        pool.push(rec);
      }
      return rec;
    };

    for (const v of payload.vendors || []) {
      const rec = upsert(state.vendors, v.code, () => ({ id: uid("ven"), code: v.code, createdAt: new Date().toISOString() }));
      rec.name = esc(v.name).trim();
      rec.contact = esc(v.contact || "").trim();
      rec.disabled = !!v.disabled;
      counts.vendors++;
    }
    for (const c of payload.contracts || []) {
      const rec = upsert(state.contracts, c.code, () => ({ id: uid("con"), code: c.code, createdAt: new Date().toISOString() }));
      rec.code = c.code;
      rec.name = esc(c.name || c.code).trim();
      rec._vendorCode = c.vendorCode || "";
      rec.budget = round2(num(c.budget));
      rec.unitPrice = round2(num(c.unitPrice));
      rec.retentionRate = round2(num(c.retentionRate || 0));
      rec.minPassRatio = num(c.minPassRatio || 0) || 0;
      rec.startDate = c.startDate;
      rec.endDate = c.endDate;
      counts.contracts++;
    }
    for (const r of payload.reels || []) {
      const rec = upsert(state.reels, r.code, () => ({ id: uid("rel"), code: r.code, createdAt: new Date().toISOString() }));
      rec.code = r.code;
      rec.name = esc(r.name || r.code).trim();
      rec._contractCode = r.contractCode;
      rec.totalFrames = Math.round(num(r.totalFrames));
      rec._prevReelCode = r.prevReelCode || "";
      counts.reels++;
    }
    for (const b of payload.batches || []) {
      const rec = upsert(state.batches, b.code, () => ({ id: uid("bat"), code: b.code, status: "待扫描", passedFrames: 0, createdAt: new Date().toISOString() }));
      rec.code = b.code;
      rec._reelCode = b.reelCode;
      rec.frames = Math.round(num(b.frames));
      rec.scannedAt = b.scannedAt || today();
      rec.operator = esc(b.operator || "导入").trim();
      if (b.status && BATCH_STATUSES.includes(b.status)) rec.status = b.status;
      rec.passedFrames = Math.max(0, Math.min(rec.passedFrames || 0, rec.frames));
      counts.batches++;
    }
    for (const d of payload.defects || []) {
      const rec = upsert(state.defects, d.code, () => ({ id: uid("def"), code: d.code, createdAt: new Date().toISOString() }));
      rec.code = d.code;
      rec._batchCode = d.batchCode;
      rec.severity = d.severity;
      rec.type = esc(d.type || "其他").trim();
      rec.description = esc(d.description || "").trim();
      rec.status = DEFECT_STATUS.includes(d.status) ? d.status : "待整改";
      if (d.thumb) { try { rec.thumb = validateThumbData(d.thumb, rec.thumb || ""); } catch (e) { /* 校验阶段已拦 */ } }
      counts.defects++;
    }
    for (const m of payload.milestones || []) {
      const rec = upsert(state.milestones, m.code, () => ({ id: uid("ms"), code: m.code, createdAt: new Date().toISOString() }));
      rec.code = m.code;
      rec.name = esc(m.name || m.code).trim();
      rec._contractCode = m.contractCode;
      rec.amount = round2(num(m.amount));
      rec.dueDate = m.dueDate || "";
      rec._prereqCodes = m.prereqCodes || [];
      counts.milestones++;
    }

    // 第二轮：按 code 解析全部引用
    for (const c of state.contracts) {
      if ("_vendorCode" in c) { c.vendorId = c._vendorCode ? (byCode(state.vendors, c._vendorCode) || {}).id || "" : ""; delete c._vendorCode; }
    }
    for (const r of state.reels) {
      if ("_contractCode" in r) {
        r.contractId = (byCode(state.contracts, r._contractCode) || {}).id || "";
        r.prevReelId = r._prevReelCode ? (byCode(state.reels, r._prevReelCode) || {}).id || "" : "";
        delete r._contractCode; delete r._prevReelCode;
      }
    }
    for (const b of state.batches) {
      if ("_reelCode" in b) { b.reelId = (byCode(state.reels, b._reelCode) || {}).id || ""; delete b._reelCode; }
    }
    for (const d of state.defects) {
      if ("_batchCode" in d) { d.batchId = (byCode(state.batches, d._batchCode) || {}).id || ""; delete d._batchCode; }
    }
    for (const m of state.milestones) {
      if ("_prereqCodes" in m) {
        m.contractId = (byCode(state.contracts, m._contractCode) || {}).id || "";
        m.prereqIds = (m._prereqCodes || []).map((pc) => (byCode(state.milestones, pc) || {}).id).filter(Boolean);
        delete m._prereqCodes; delete m._contractCode;
      }
    }

    const summary = Object.entries(counts).map(([k, v]) => `${v} ${labelOf(k)}`).join("，");
    audit(state, { actor: ctx.userName || ctx.role, role: ctx.role, action: "导入档案", target: "import.json", detail: summary });
    return { state, events: [{ type: "imported", counts }], errors: [] };
  };

  function labelOf(k) {
    return { vendors: "外包商", contracts: "合同", reels: "胶片卷", batches: "批次", defects: "缺陷", milestones: "付款节点" }[k] || k;
  }

  /** 拒绝动作：丢弃工作副本的业务改动，仅把新增审计行（位于数组头部，最新在前）带回原数据克隆 */
  function rejectState(original, work) {
    const next = structuredClone(original);
    if (!next.audit) next.audit = [];
    const oldLen = (original.audit || []).length;
    const extra = (work.audit || []).slice(0, Math.max(0, work.audit.length - oldLen));
    next.audit = extra.concat(next.audit);
    if (next.audit.length > 2000) next.audit.length = 2000;
    return next;
  }

  /* ============================== Reducer 入口 ============================== */

  function dispatch(state, action, ctx) {
    ctx = ctx || { role: "admin", userName: "系统" };
    if (!action || !action.type) return { state, events: [], errors: [fail("BAD_ACTION", "缺少 action.type")] };
    const h = handlers[action.type];
    if (!h) return { state, events: [], errors: [fail("NO_HANDLER", `未知动作 ${action.type}`)] };
    // 深拷贝工作副本，失败动作不会半改数据
    const work = structuredClone(state);
    if (!work.audit) work.audit = [];
    let out;
    try {
      out = h(work, action, ctx);
    } catch (e) {
      if (e instanceof ValidationError) {
        audit(work, {
          actor: ctx.userName || ctx.role,
          role: ctx.role,
          action: action.type,
          target: action.data ? action.data.code : "",
          result: "denied",
          reason: e.message
        });
        return { state: rejectState(state, work), events: [], errors: [fail("VALIDATION", e.message)] };
      }
      throw e;
    }
    if (out.errors && out.errors.length) {
      // denied 已在工作副本写审计；校验类错误若 handler 没写，补一条
      const wroteAudit = work.audit.length !== (state.audit ? state.audit.length : 0);
      if (!wroteAudit) {
        audit(work, { actor: ctx.userName || ctx.role, role: ctx.role, action: action.type, result: "denied", reason: out.errors.map((e) => e.message).join("；"), target: action.data ? action.data.code : "" });
      }
      // 原子性：丢弃工作副本里的全部业务改动，只把新增的（拒绝）审计行追加到原数据克隆
      return { state: rejectState(state, work), events: out.events || [], errors: out.errors };
    }
    return out;
  }

  /* ============================== 种子数据 ============================== */

  function seedState() {
    let s = emptyState();
    const ctx = { role: "admin", userName: "初始化" };
    const run = (action) => {
      const r = dispatch(s, action, ctx);
      if (r.errors.length) throw new Error("seed failed: " + r.errors[0].message);
      s = r.state;
    };
    run({ type: "saveVendor", data: { code: "V-华影", name: "华影数字化外包有限公司", contact: "周经理 138-0000-1111" } });
    const vendor = s.vendors[0];
    run({
      type: "saveContract",
      data: { code: "HT-2026-01", name: "2026 年度老胶片数字化合同", vendorId: vendor.id, budget: 300000, unitPrice: 1, retentionRate: 0.1, minPassRatio: 0, startDate: "2026-01-01", endDate: "2026-12-31" }
    });
    const con = s.contracts[0];
    run({ type: "saveReel", data: { code: "R-A01", name: "春日试映 A 卷", contractId: con.id, totalFrames: 12000, prevReelId: "" } });
    run({ type: "saveReel", data: { code: "R-A02", name: "春日试映 B 卷", contractId: con.id, totalFrames: 9000, prevReelId: s.reels[0].id } });
    const [r1, r2] = s.reels;
    run({ type: "saveBatch", data: { code: "B-001", reelId: r1.id, frames: 10000, scannedAt: "2026-03-02", operator: "扫描员甲" } });
    run({ type: "saveBatch", data: { code: "B-002", reelId: r1.id, frames: 2000, scannedAt: "2026-03-05", operator: "扫描员甲" } });
    run({ type: "saveBatch", data: { code: "B-003", reelId: r2.id, frames: 9000, scannedAt: "2026-03-08", operator: "扫描员乙" } });
    run({ type: "saveMilestone", data: { code: "MS-01", name: "首批验收款", contractId: con.id, amount: 100000, dueDate: "2026-04-01", prereqIds: [] } });
    run({ type: "saveMilestone", data: { code: "MS-02", name: "中期款", contractId: con.id, amount: 100000, dueDate: "2026-06-01", prereqIds: [s.milestones[0].id] } });
    run({ type: "saveMilestone", data: { code: "MS-03", name: "尾款", contractId: con.id, amount: 100000, dueDate: "2026-09-30", prereqIds: [s.milestones[1].id] } });
    // B-001 走完：验收→登记 9950 合格 + 1 一般缺陷→通过
    run({ type: "transitionBatch", batchId: s.batches[0].id, to: "验收" });
    run({ type: "acceptBatch", batchId: s.batches[0].id, passedFrames: 9950, defects: [{ code: "D-001", severity: "一般", type: "轻微划痕", description: "片头 2 秒轻微划痕，不影响使用" }] });
    run({ type: "transitionBatch", batchId: s.batches[0].id, to: "通过" });
    // B-002 在验收中，带一个关键缺陷（未闭环）——用于演示关键缺陷拦截
    run({ type: "transitionBatch", batchId: s.batches[1].id, to: "验收" });
    run({ type: "saveDefect", data: { code: "D-002", batchId: s.batches[1].id, severity: "关键", type: "画格丢失", description: "第 410~430 帧扫描丢帧，需重新扫描", status: "待整改" } });
    // B-003 待扫描
    return s;
  }

  function emptyState() {
    return {
      version: 1,
      vendors: [],
      contracts: [],
      reels: [],
      batches: [],
      defects: [],
      milestones: [],
      payments: [],
      audit: []
    };
  }

  function base64ToBytes(b64) {
    const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
    if (typeof atob === "function") {
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(clean, "base64"));
  }

  function signatureOf(bytes) {
    return Array.from(bytes.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  return {
    ROLES,
    BATCH_STATUSES,
    BATCH_TRANSITIONS,
    APPROVAL_STEPS,
    DEFECT_SEVERITIES,
    DEFECT_STATUS,
    PAYMENT_STATUSES,
    SEVERITY_CRITICAL,
    uid,
    num,
    round2,
    isValidDate,
    isLeapYear,
    daysInMonth,
    today,
    detectCycleFrom,
    findAnyCycle,
    contractStats,
    milestoneStats,
    batchAcceptedFrames,
    batchPassRatio,
    batchGrossValue,
    requiredLevelFor,
    requiredSteps,
    computePaymentAmounts,
    validatePaymentState,
    openCriticalDefectIds,
    validateImport,
    validateThumbData,
    base64ToBytes,
    dispatch,
    handlers,
    audit,
    seedState,
    emptyState,
    byCode,
    byId
  };
});
