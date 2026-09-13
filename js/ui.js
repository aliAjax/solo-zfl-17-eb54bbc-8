/*
 * ui.js —— 视图渲染与控制器。所有写操作都走 store.commit（业务规则全部在 core）。
 */
(function () {
  "use strict";
  const C = window.Core;
  const { Store } = window.Store;

  /* ---------------- 工具 ---------------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? "" : v)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  const money = (n) => "¥" + (Number(n) || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (n) => ((Number(n) || 0) * 100).toFixed(1) + "%";
  const dt = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "");
  const dtShort = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "");

  function toast(message, kind) {
    const host = $("#toastHost");
    const el = document.createElement("div");
    el.className = "toast " + (kind || "err");
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, kind === "ok" ? 2600 : 5200);
  }

  function confirm2(message) {
    return window.confirm(message);
  }

  /* ---------------- 全局状态 ---------------- */

  const store = new Store({
    role: localStorage.getItem("digitdesk:role") || "pm",
    userName: localStorage.getItem("digitdesk:user") || "",
    tabName: window.__digitdeskTabName || ("标签页 " + Math.floor(Math.random() * 900 + 100)),
    bus: window.__digitdeskBus || undefined,
    pageId: window.__digitdeskPageId || undefined
  });

  const ui = {
    tab: "dashboard",
    recordSeg: "vendor",
    editingRecord: null, // {kind, id}
    acceptBatchId: null,
    defectEditId: null,
    paymentEditId: null,
    pf: null // 付款单编辑对象
  };

  /* ---------------- 初始化角色条 ---------------- */

  function initRoleBar() {
    const sel = $("#roleSelect");
    sel.innerHTML = Object.entries(C.ROLES)
      .map(([key, r]) => `<option value="${key}">${r.name}</option>`)
      .join("");
    sel.value = store.role;
    $("#userNameInput").value = store.userName || C.ROLES[store.role].name;
    sel.addEventListener("change", () => {
      store.setActor(sel.value, $("#userNameInput").value.trim() || C.ROLES[sel.value].name);
      localStorage.setItem("digitdesk:role", sel.value);
      // 延迟渲染：该 change 可能由“点击下方按钮导致控件失焦”触发，同步重建会替换正在点击的节点，
      // 使浏览器抑制本次 click（pointerdown/up 命中却不产生 click）。角色已立即写入，处理器仍读到新角色。
      scheduleRender();
    });
    $("#userNameInput").addEventListener("change", () => {
      const name = $("#userNameInput").value.trim() || C.ROLES[sel.value].name;
      store.setActor(sel.value, name);
      localStorage.setItem("digitdesk:user", name);
      scheduleRender();
    });
  }

  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const flush = () => {
      renderScheduled = false;
      renderAll();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }

  /* ---------------- Tab 切换 ---------------- */

  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    ui.tab = btn.dataset.tab;
    $$("#tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === ui.tab));
    renderAll();
  });
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-goto]");
    if (g) {
      $("#tabs").querySelector(`[data-tab="${g.dataset.goto}"]`).click();
    }
  });

  /* ---------------- store 事件 ---------------- */

  store.on("denied", (ev) => {
    for (const err of ev.detail || []) toast(err.message, "err");
  });
  store.on("conflict", (ev) => {
    const banner = $("#conflictBanner");
    banner.textContent = "⚠ " + ev.detail.message;
    banner.classList.remove("hidden");
    setTimeout(() => banner.classList.add("hidden"), 8000);
    toast("双页竞争：对方操作先生效，本页已刷新为权威数据", "err");
  });
  store.on("change", () => renderAll());
  store.on("snapshots", () => {
    if (ui.tab === "history") renderHistory();
  });
  setInterval(() => {
    if (ui.tab === "dashboard") renderPresenceLocks();
  }, 4000);

  function commit(action, okMsg) {
    const r = store.commit(action);
    if (!r.errors.length && okMsg) toast(okMsg, "ok");
    return r;
  }

  /* ============================================================
   * 概览
   * ============================================================ */

  function renderDashboard() {
    const s = store.state;
    const counts = Object.fromEntries(C.BATCH_STATUSES.map((x) => [x, 0]));
    s.batches.forEach((b) => (counts[b.status] = (counts[b.status] || 0) + 1));
    const openCrit = s.defects.filter((d) => d.severity === "关键" && d.status !== "闭环").length;
    const pendingPay = s.payments.filter((p) => ["待审批", "审批中"].includes(p.status)).length;
    const approvedPay = s.payments.filter((p) => p.status === "已批准").length;
    const paidTotal = s.payments.filter((p) => p.status === "已付款").reduce((a, p) => a + (p.net || 0), 0);
    const budgetTotal = s.contracts.reduce((a, c) => a + (c.budget || 0), 0);
    const committedTotal = s.contracts.reduce((a, c) => a + C.contractStats(s, c.id).committed, 0);

    $("#statGrid").innerHTML = [
      ["胶片卷", s.reels.length, ""],
      ["扫描批次", s.batches.length, `${counts["验收"] || 0} 验收中`],
      ["未闭环关键缺陷", openCrit, openCrit ? "关键缺陷未闭环，禁止相关批次付款" : "无关键阻塞"],
      ["待审批付款", pendingPay, `${approvedPay} 笔已批准待付款`],
      ["累计已付款", money(paidTotal), ""],
      ["合同预算占用", money(committedTotal), `总额度 ${money(budgetTotal)}`]
    ]
      .map(
        ([label, val, sub], i) => `
      <div class="stat-card ${i === 2 && openCrit ? "danger" : ""}">
        <span>${label}</span><strong>${val}</strong><em>${esc(sub)}</em>
      </div>`
      )
      .join("");

    // 流水线看板
    $("#pipelineHint").textContent = `合法流转：待扫描→验收→（返工↔验收）→通过；任意状态可冻结（仅项目经理/管理员）`;
    $("#pipelineBoard").innerHTML = C.BATCH_STATUSES.map((st) => {
      const list = s.batches.filter((b) => b.status === st);
      return `<div class="pipe-col pipe-${st}">
        <h3>${st}<span>${list.length}</span></h3>
        <div class="pipe-chips">
          ${list
            .map((b) => {
              const crit = C.openCriticalDefectIds(s, b.id).length;
              return `<button class="chip ${crit ? "crit" : ""}" data-open-batch="${b.id}" title="点击去验收台处理">${esc(b.code)}${crit ? " 🔴" : ""}</button>`;
            })
            .join("") || `<span class="muted">—</span>`}
        </div>
      </div>`;
    }).join("");

    // 预算占用
    $("#budgetBoard").innerHTML = s.contracts
      .map((c) => {
        const st = C.contractStats(s, c.id);
        const ratio = Math.min(1, c.budget ? st.committed / c.budget : 0);
        const over = st.remaining < 0;
        return `<div class="budget-row">
          <div class="budget-line"><strong>${esc(c.code)}</strong><span>${money(st.committed)} / ${money(c.budget)}（已付 ${money(st.paid)}）</span></div>
          <div class="bar ${over ? "over" : ""}"><i style="width:${ratio * 100}%"></i></div>
          <div class="budget-sub">合格画幅 ${st.passedFrames}/${st.totalFrames}（${pct(st.passRatio)}）· 保证金 ${pct(c.retentionRate)}</div>
        </div>`;
      })
      .join("") || `<p class="muted">还没有合同。</p>`;

    // 最近审计
    $("#recentAudit").innerHTML = renderAuditRows(s.audit.slice(0, 8));

    renderPresenceLocks();
  }

  $("#pipelineBoard")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-open-batch]");
    if (chip) {
      $("#tabs").querySelector('[data-tab="acceptance"]').click();
      ui.acceptBatchId = chip.dataset.openBatch;
      renderBatches();
    }
  });

  function renderPresenceLocks() {
    const pres = store.listPresence();
    $("#presenceBoard").innerHTML = `<ul class="presence-list">
      ${pres
        .map((p) => `<li class="${p.pageId === store.pageId ? "me" : ""}">${esc(p.tabName)}${p.pageId === store.pageId ? "（本页）" : ""} · ${esc(C.ROLES[p.role] ? C.ROLES[p.role].name : p.role)} · ${esc(p.by)} <span>${dtShort(new Date(p.at).toISOString())}</span></li>`)
        .join("")}
    </ul>`;
    const locks = store.listLocks();
    $("#locksBoard").innerHTML = locks.length
      ? `<ul class="lock-list">${locks
          .map((l) => `<li class="${l.mine ? "mine" : ""}">${lockLabel(l)} — ${esc(l.tabName)} · ${esc(l.by)}${l.mine ? ` <button data-release-lock="${l.entity}|${l.id}">释放</button>` : "（30 秒租约）"}</li>`)
          .join("")}</ul>`
      : `<p class="muted">当前没有编辑锁。</p>`;
  }

  function lockLabel(l) {
    const s = store.state;
    const pool = { vendor: s.vendors, contract: s.contracts, reel: s.reels, batch: s.batches, defect: s.defects, milestone: s.milestones, payment: s.payments }[l.entity];
    const rec = pool && pool.find((x) => x.id === l.id);
    return `${entityKindName(l.entity)}「${rec ? rec.code : l.id}」`;
  }
  function entityKindName(k) {
    return { vendor: "外包商", contract: "合同", reel: "胶片卷", batch: "批次", defect: "缺陷", milestone: "付款节点", payment: "付款单" }[k] || k;
  }

  /* ============================================================
   * 基础档案
   * ============================================================ */

  const RECORD_KINDS = {
    vendor: { title: "外包商", roles: ["admin", "pm"] },
    contract: { title: "合同", roles: ["admin", "pm"] },
    reel: { title: "胶片卷", roles: ["admin", "pm", "qc"] },
    milestone: { title: "付款节点", roles: ["admin", "pm"] }
  };

  $("#recordsSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-seg]");
    if (!btn) return;
    ui.recordSeg = btn.dataset.seg;
    ui.editingRecord = null;
    store.releaseAllMyLocks();
    $$("#recordsSeg button").forEach((b) => b.classList.toggle("active", b === btn));
    renderRecords();
  });

  function renderRecords() {
    renderRecordForm();
    renderRecordList();
  }

  function options(list, value, blankLabel) {
    return (blankLabel ? `<option value="">${blankLabel}</option>` : "") + list.map((x) => `<option value="${x.id}" ${x.id === value ? "selected" : ""}>${esc(x.code)} ${esc(x.name || "")}</option>`).join("");
  }

  function renderRecordForm() {
    const s = store.state;
    const kind = ui.recordSeg;
    let rec = null;
    if (ui.editingRecord && ui.editingRecord.kind === kind) {
      const pool = { vendor: s.vendors, contract: s.contracts, reel: s.reels, milestone: s.milestones }[kind];
      rec = pool.find((x) => x.id === ui.editingRecord.id) || null;
    }
    const f = $("#recordForm");
    let html = `<h3>${rec ? "编辑" : "新增"}${RECORD_KINDS[kind].title}</h3>`;
    if (kind === "vendor") {
      html += `
        <label>编号 *<input name="code" required value="${esc(rec?.code || "")}" placeholder="V-华影" /></label>
        <label>名称 *<input name="name" required value="${esc(rec?.name || "")}" /></label>
        <label>联系方式<input name="contact" value="${esc(rec?.contact || "")}" /></label>
        <label class="check"><input type="checkbox" name="disabled" ${rec?.disabled ? "checked" : ""}/> 停用（不出现在新合同选项中）</label>`;
    } else if (kind === "contract") {
      html += `
        <label>合同编号 *<input name="code" required value="${esc(rec?.code || "")}" placeholder="HT-2026-01" /></label>
        <label>合同名称<input name="name" value="${esc(rec?.name || "")}" /></label>
        <label>外包商 *<select name="vendorId">${options(s.vendors.filter((v) => !v.disabled), rec?.vendorId, "请选择")}</select></label>
        <div class="form-grid-2">
          <label>合同预算 *<input name="budget" type="number" step="0.01" min="0.01" value="${rec?.budget ?? ""}" /></label>
          <label>单帧价格 *<input name="unitPrice" type="number" step="0.01" min="0.01" value="${rec?.unitPrice ?? ""}" /></label>
          <label>保证金扣留比例（0~1）<input name="retentionRate" type="number" step="0.01" min="0" max="1" value="${rec?.retentionRate ?? 0.1}" /></label>
          <label>最低验收比例（0~1，0=不限制）<input name="minPassRatio" type="number" step="0.01" min="0" max="1" value="${rec?.minPassRatio ?? 0}" /></label>
          <label>开始日期 *<input name="startDate" type="date" value="${esc(rec?.startDate || "")}" /></label>
          <label>结束日期 *<input name="endDate" type="date" value="${esc(rec?.endDate || "")}" /></label>
        </div>`;
    } else if (kind === "reel") {
      const others = s.reels.filter((x) => x.id !== rec?.id);
      html += `
        <label>胶片卷编号 *<input name="code" required value="${esc(rec?.code || "")}" placeholder="R-A01" /></label>
        <label>卷名<input name="name" value="${esc(rec?.name || "")}" /></label>
        <label>所属合同 *<select name="contractId">${options(s.contracts, rec?.contractId, "请选择")}</select></label>
        <label>总画幅数 *<input name="totalFrames" type="number" step="1" min="1" value="${rec?.totalFrames ?? ""}" /></label>
        <label>接续上一卷（防止断档/循环引用）<select name="prevReelId">${options(others, rec?.prevReelId, "无（首卷）")}</select></label>`;
    } else if (kind === "milestone") {
      const contractId = rec?.contractId || s.contracts[0]?.id || "";
      const candidates = s.milestones.filter((m) => m.id !== rec?.id && (!contractId || m.contractId === contractId));
      html += `
        <label>节点编号 *<input name="code" required value="${esc(rec?.code || "")}" placeholder="MS-01" /></label>
        <label>节点名称<input name="name" value="${esc(rec?.name || "")}" /></label>
        <label>所属合同 *<select name="contractId">${options(s.contracts, contractId, "请选择")}</select></label>
        <div class="form-grid-2">
          <label>节点金额 *<input name="amount" type="number" step="0.01" min="0.01" value="${rec?.amount ?? ""}" /></label>
          <label>计划日期<input name="dueDate" type="date" value="${esc(rec?.dueDate || "")}" /></label>
        </div>
        <fieldset class="check-group"><legend>前置付款节点（前置未付款，本节点不能付款；不可成环）</legend>
          ${candidates
            .map((m) => `<label class="check"><input type="checkbox" name="prereq" value="${m.id}" ${rec?.prereqIds?.includes(m.id) ? "checked" : ""}/> ${esc(m.code)} ${esc(m.name)}</label>`)
            .join("") || `<span class="muted">该合同下暂无其他节点</span>`}
        </fieldset>`;
    }
    html += `<div class="btn-row">
      <button type="submit" class="primary">${rec ? "保存修改" : "新增"}</button>
      ${rec ? `<button type="button" id="cancelRecordEdit">取消编辑</button>` : ""}
    </div>
    <p class="hint">${RECORD_KINDS[kind].title}的新增/编辑权限：${RECORD_KINDS[kind].roles.map((r) => C.ROLES[r].name).join("、")}。编号全局唯一，重复编号会被拒绝。</p>`;
    f.innerHTML = html;
  }

  function renderRecordList() {
    const s = store.state;
    const kind = ui.recordSeg;
    const el = $("#recordList");
    const lockOf = (id) => store.listLocks().find((l) => l.entity === kind && l.id === id);
    if (kind === "vendor") {
      el.innerHTML = s.vendors
        .map(
          (v) => {
            const lk = lockOf(v.id);
            const used = s.contracts.filter((c) => c.vendorId === v.id).length;
            return `<div class="rec-card ${v.disabled ? "disabled" : ""}">
            <div><strong>${esc(v.code)}</strong> ${esc(v.name)} <span class="muted">${esc(v.contact)}</span>${used ? `<em class="tag">${used} 份合同</em>` : ""}</div>
            <div class="row-actions">
              ${lk && !lk.mine ? `<span class="lock-tag">${esc(lk.tabName)} 编辑中</span>` : ""}
              <button data-edit="${kind}|${v.id}">编辑</button>
              <button data-del="${kind}|${v.id}" class="danger-text">删除</button>
            </div></div>`;
          }
        )
        .join("") || `<p class="muted">还没有外包商。</p>`;
    } else if (kind === "contract") {
      el.innerHTML = s.contracts
        .map((c) => {
          const st = C.contractStats(s, c.id);
          const vendor = s.vendors.find((v) => v.id === c.vendorId);
          return `<div class="rec-card">
            <div><strong>${esc(c.code)}</strong> ${esc(c.name)} <span class="muted">${esc(vendor ? vendor.name : "（未指定外包商）")}</span></div>
            <div class="kv-grid">
              <span>预算 <b>${money(c.budget)}</b></span><span>单帧 ${money(c.unitPrice)}</span>
              <span>保证金 ${pct(c.retentionRate)}</span><span>最低验收 ${pct(c.minPassRatio)}</span>
              <span>有效期 ${esc(c.startDate)} ~ ${esc(c.endDate)}</span>
              <span class="${st.remaining < 0 ? "text-danger" : ""}">在途 ${money(st.committed)} / 已付 ${money(st.paid)}</span>
            </div>
            <div class="row-actions">
              <button data-edit="contract|${c.id}">编辑</button>
              <button data-del="contract|${c.id}" class="danger-text">删除</button>
            </div></div>`;
        })
        .join("") || `<p class="muted">还没有合同。</p>`;
    } else if (kind === "reel") {
      el.innerHTML = s.reels
        .map((r) => {
          const con = s.contracts.find((c) => c.id === r.contractId);
          const prev = s.reels.find((x) => x.id === r.prevReelId);
          const frames = s.batches.filter((b) => b.reelId === r.id).reduce((a, b) => a + b.frames, 0);
          return `<div class="rec-card">
            <div><strong>${esc(r.code)}</strong> ${esc(r.name)} <span class="muted">${esc(con ? con.code : "?")}${prev ? " · 接续 " + esc(prev.code) : ""}</span></div>
            <div class="kv-grid"><span>总画幅 ${r.totalFrames}</span><span>已扫描 ${frames}</span></div>
            <div class="row-actions">
              <button data-edit="reel|${r.id}">编辑</button>
              <button data-del="reel|${r.id}" class="danger-text">删除</button>
            </div></div>`;
        })
        .join("") || `<p class="muted">还没有胶片卷。</p>`;
    } else {
      el.innerHTML = s.milestones
        .map((m) => {
          const st = C.milestoneStats(s, m.id);
          const con = s.contracts.find((c) => c.id === m.contractId);
          return `<div class="rec-card">
            <div><strong>${esc(m.code)}</strong> ${esc(m.name)} <span class="muted">${esc(con ? con.code : "?")} · ${esc(m.dueDate)}</span></div>
            <div class="kv-grid"><span>额度 ${money(m.amount)}</span><span class="${st.remaining < 0 ? "text-danger" : ""}">已占用 ${money(st.committed)}（余 ${money(st.remaining)}）</span><span>前置：${(m.prereqIds || []).map((id) => esc((s.milestones.find((x) => x.id === id) || {}).code)).join("、") || "无"}</span></div>
            <div class="row-actions">
              <button data-edit="milestone|${m.id}">编辑</button>
              <button data-del="milestone|${m.id}" class="danger-text">删除</button>
            </div></div>`;
        })
        .join("") || `<p class="muted">还没有付款节点。</p>`;
    }
  }

  $("#recordList").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit]");
    const dl = e.target.closest("[data-del]");
    if (ed) {
      const [kind, id] = ed.dataset.edit.split("|");
      const got = store.acquireLock(kind, id);
      if (!got.ok) {
        toast(`该记录正被 ${got.holder.tabName}（${got.holder.by}）编辑，锁 30 秒后自动释放，请勿双页同时修改`, "err");
        return;
      }
      ui.editingRecord = { kind, id };
      if (ui.recordSeg !== kind) {
        ui.recordSeg = kind;
        $$("#recordsSeg button").forEach((b) => b.classList.toggle("active", b.dataset.seg === kind));
      }
      renderRecords();
    }
    if (dl) {
      const [kind, id] = dl.dataset.del.split("|");
      if (!confirm2(`确认删除该${RECORD_KINDS[kind]?.title || entityKindName(kind)}？有关联引用时会被拒绝。`)) return;
      commit({ type: "deleteEntity", kind, id }, "已删除");
    }
  });

  $("#recordForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const kind = ui.recordSeg;
    const fd = new FormData(f);
    const id = ui.editingRecord?.kind === kind ? ui.editingRecord.id : undefined;
    const data = {};
    fd.forEach((v, k) => (data[k] = typeof v === "string" ? v.trim() : v));
    data.id = id;
    if (kind === "milestone") data.prereqIds = $$('input[name="prereq"]:checked', f).map((x) => x.value);
    const typeMap = { vendor: "saveVendor", contract: "saveContract", reel: "saveReel", milestone: "saveMilestone" };
    const r = commit({ type: typeMap[kind], data });
    if (!r.errors.length) {
      if (id) store.releaseLock(kind, id);
      ui.editingRecord = null;
      f.reset();
      renderRecords();
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("#cancelRecordEdit")) {
      if (ui.editingRecord) store.releaseLock(ui.editingRecord.kind, ui.editingRecord.id);
      ui.editingRecord = null;
      renderRecords();
    }
  });
  // 合同切换时刷新节点前置选项
  $("#recordForm").addEventListener("change", (e) => {
    if (ui.recordSeg === "milestone" && e.target.name === "contractId") {
      const id = ui.editingRecord?.kind === "milestone" ? ui.editingRecord.id : null;
      if (id) return; // 编辑中保留
      renderRecordForm();
    }
  });

  /* ============================================================
   * 扫描批次 + 验收
   * ============================================================ */

  function initBatchFilters() {
    $("#batchStatusFilter").innerHTML = `<option value="">全部状态</option>` + C.BATCH_STATUSES.map((s) => `<option>${s}</option>`).join("");
    $("#batchStatusFilter").value = "";
  }
  $("#batchStatusFilter")?.addEventListener("change", renderBatches);
  $("#batchSearch")?.addEventListener("input", renderBatches);

  function renderBatches() {
    const s = store.state;
    const kw = $("#batchSearch").value.trim();
    const stf = $("#batchStatusFilter").value;
    let list = s.batches;
    if (stf) list = list.filter((b) => b.status === stf);
    if (kw) list = list.filter((b) => b.code.includes(kw) || (b.operator || "").includes(kw));
    const createCard = `<div class="batch-card new-batch">
      <h3>＋ 新建扫描批次</h3>
      <form id="newBatchForm" class="inline-form">
        <div class="form-grid-4">
          <label>批次号 *<input name="code" required placeholder="B-004" /></label>
          <label>胶片卷 *<select name="reelId">${options(s.reels, "", "请选择")}</select></label>
          <label>扫描画幅 *<input name="frames" type="number" min="1" step="1" required /></label>
          <label>扫描日期<input name="scannedAt" type="date" value="${C.today()}" /></label>
        </div>
        <label>扫描操作员<input name="operator" value="${esc(store.userName)}" /></label>
        <button class="primary">创建批次（状态：待扫描）</button>
      </form></div>`;

    $("#batchList").innerHTML =
      createCard +
      list
        .map((b) => {
          const reel = s.reels.find((r) => r.id === b.reelId);
          const con = reel && s.contracts.find((c) => c.id === reel.contractId);
          const defects = s.defects.filter((d) => d.batchId === b.id);
          const critOpen = defects.filter((d) => d.severity === "关键" && d.status !== "闭环");
          const ratio = b.frames ? Math.round((b.passedFrames / b.frames) * 100) : 0;
          const next = Object.keys(C.BATCH_TRANSITIONS[b.status] || {});
          const canFreeze = ["pm", "admin"].includes(store.role);
          const lk = store.listLocks().find((l) => l.entity === "batch" && l.id === b.id);
          return `<div class="batch-card status-${b.status}">
            <div class="batch-head">
              <div><strong>${esc(b.code)}</strong> <span class="status-tag st-${b.status}">${b.status}</span></div>
              <div class="muted">${esc(reel ? reel.code : "?")} · ${esc(con ? con.code : "")} · ${b.frames} 画幅 · ${esc(b.scannedAt || "")} · ${esc(b.operator || "")}</div>
            </div>
            <div class="batch-metrics">
              <span>合格 <b>${b.passedFrames || 0}</b>/${b.frames}（${ratio}%）</span>
              <span>合格画幅产值 <b>${money(C.batchGrossValue(s, b))}</b></span>
              <span class="${critOpen.length ? "text-danger" : ""}">缺陷 ${defects.length}（未闭环关键 ${critOpen.length}）</span>
            </div>
            ${critOpen.length ? `<div class="crit-box">🔴 未闭环关键缺陷：${critOpen.map((d) => esc(d.code)).join("、")}——该批次不能判通过、不能进入付款</div>` : ""}
            ${defects.length ? `<div class="defect-line">${defects.map((d) => `<span class="mini-tag sev-${d.severity} stx-${d.status}">${esc(d.code)} ${d.severity}/${d.status}</span>`).join(" ")}</div>` : ""}
            <div class="row-actions">
              ${b.status === "验收" ? `<button data-accept="${b.id}" class="primary">验收登记</button>` : ""}
              ${next
                .filter((to) => to !== b.status)
                .map((to) => {
                  const disabled = to === "冻结" && !canFreeze;
                  return `<button data-trans="${b.id}|${to}" ${disabled ? `disabled title="只有项目经理/管理员可以冻结"` : ""}>→ ${to}</button>`;
                })
                .join("")}
              ${lk && lk.mine ? `<button data-release-lock="batch|${b.id}">释放我的编辑锁</button>` : ""}
            </div>
          </div>`;
        })
        .join("");

    // 验收编辑器
    const editor = $("#acceptEditor");
    if (ui.acceptBatchId) renderAcceptEditor();
    else editor.classList.add("hidden");
  }

  $("#batchList").addEventListener("submit", (e) => {
    const f = e.target.closest("#newBatchForm");
    if (!f) return;
    e.preventDefault();
    const fd = new FormData(f);
    const data = Object.fromEntries(fd.entries());
    data.frames = Number(data.frames);
    const r = commit({ type: "saveBatch", data }, "批次已创建（待扫描）");
    if (!r.errors.length) f.reset();
  });

  $("#batchList").addEventListener("click", (e) => {
    const t = e.target.closest("[data-trans]");
    const ac = e.target.closest("[data-accept]");
    if (t) {
      const [id, to] = t.dataset.trans.split("|");
      commit({ type: "transitionBatch", batchId: id, to }, `已流转到「${to}」`);
    }
    if (ac) {
      const id = ac.dataset.accept;
      const got = store.acquireLock("batch", id);
      if (!got.ok) {
        toast(`该批次正被 ${got.holder.tabName}（${got.holder.by}）验收，双页不能同时登记`, "err");
        return;
      }
      ui.acceptBatchId = id;
      renderBatches();
    }
  });

  function renderAcceptEditor() {
    const s = store.state;
    const b = s.batches.find((x) => x.id === ui.acceptBatchId);
    const editor = $("#acceptEditor");
    if (!b) {
      editor.classList.add("hidden");
      ui.acceptBatchId = null;
      return;
    }
    editor.classList.remove("hidden");
    $("#acceptEditorTitle").textContent = `验收登记 · ${b.code}`;
    const rejects = b.frames - (b.passedFrames || 0);
    $("#acceptForm").innerHTML = `
      <div class="form-grid-4">
        <label>扫描画幅（只读）<input value="${b.frames}" disabled /></label>
        <label>合格画幅 *<input name="passedFrames" type="number" min="0" max="${b.frames}" step="1" value="${b.passedFrames || 0}" /></label>
        <label>不合格（自动）<input id="rejectFrames" value="${rejects}" disabled /></label>
        <label>判定提示<div class="inline-help" id="acceptHint"></div></label>
      </div>
      <h3 class="subhead">同步登记缺陷（可选，可多次）</h3>
      <div class="form-grid-4">
        <label>缺陷编号 *<input name="dcode" placeholder="D-003" /></label>
        <label>等级 *<select name="severity"><option>一般</option><option>主要</option><option>关键</option></select></label>
        <label>类型<input name="dtype" placeholder="划痕/丢帧/偏色…" /></label>
        <label>描述<input name="ddesc" placeholder="位置、现象" /></label>
      </div>
      <div class="btn-row">
        <button class="primary" name="mode" value="save">保存验收登记（保持验收中）</button>
        <button name="mode" value="pass">保存并判通过</button>
        <button name="mode" value="rework">保存并转返工</button>
        <button type="button" id="acceptCancel">取消</button>
      </div>
      <p class="hint">部分通过：合格画幅可小于扫描画幅，按合格画幅 × 合同单帧价计入付款；不合格部分不付款。判通过时若有未闭环关键缺陷会被拒绝。</p>`;
    const hint = () => {
      const v = Number($("#acceptForm [name=passedFrames]").value);
      const h = $("#acceptHint");
      if (!(v >= 0)) return (h.textContent = "");
      const r = Math.round((v / b.frames) * 100);
      h.textContent = v === b.frames ? `全部合格 ${r}%` : v === 0 ? "合格为 0：不能判通过，应返工或冻结" : `部分通过：合格率 ${r}%，按 ${v} 画幅计价`;
      h.className = "inline-help " + (v < b.frames ? "warn" : "ok");
    };
    $("#acceptForm [name=passedFrames]").addEventListener("input", () => {
      $("#rejectFrames").value = b.frames - Number($("#acceptForm [name=passedFrames]").value || 0);
      hint();
    });
    hint();
  }

  $("#acceptClose").addEventListener("click", closeAccept);
  function closeAccept() {
    if (ui.acceptBatchId) store.releaseLock("batch", ui.acceptBatchId);
    ui.acceptBatchId = null;
    renderBatches();
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("#acceptCancel")) closeAccept();
  });

  $("#acceptForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const fd = new FormData(f);
    const id = ui.acceptBatchId;
    const defects = fd.get("dcode")
      ? [{ code: fd.get("dcode"), severity: fd.get("severity"), type: fd.get("dtype"), description: fd.get("ddesc") }]
      : [];
    let r = commit({ type: "acceptBatch", batchId: id, passedFrames: Number(fd.get("passedFrames")), defects });
    if (r.errors.length) return;
    const mode = e.submitter?.value || "save";
    if (mode === "pass") r = commit({ type: "transitionBatch", batchId: id, to: "通过" }, "已判通过");
    if (mode === "rework") r = commit({ type: "transitionBatch", batchId: id, to: "返工" }, "已转返工");
    if (!r.errors.length && mode !== "save") closeAccept();
    else if (!r.errors.length) renderBatches();
  });

  /* ============================================================
   * 质检缺陷
   * ============================================================ */

  $("#defectSeverityFilter")?.addEventListener("change", renderDefects);
  $("#defectStatusFilter")?.addEventListener("change", renderDefects);

  function renderDefectForm() {
    const s = store.state;
    const rec = ui.defectEditId ? s.defects.find((d) => d.id === ui.defectEditId) : null;
    $("#defectForm").innerHTML = `<h3>${rec ? "编辑缺陷 " + esc(rec.code) : "登记缺陷"}</h3>
      <div class="form-grid-4">
        <label>缺陷编号 *<input name="code" required value="${esc(rec?.code || "")}" placeholder="D-003" /></label>
        <label>所属批次 *<select name="batchId">${options(s.batches, rec?.batchId, "请选择")}</select></label>
        <label>等级 *<select name="severity">${C.DEFECT_SEVERITIES.map((x) => `<option ${rec?.severity === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label>类型<input name="type" value="${esc(rec?.type || "")}" placeholder="丢帧/划痕/偏色…" /></label>
      </div>
      <label>描述<textarea name="description" rows="2">${esc(rec?.description || "")}</textarea></label>
      <div class="form-grid-2">
        <label>状态 *<select name="status">${C.DEFECT_STATUS.map((x) => `<option ${rec?.status === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label>缩略图（仅 PNG/JPEG/GIF/WEBP，校验文件魔数，伪装文件会被拒绝）
          <input name="thumb" type="file" accept="image/png,image/jpeg,image/gif,image/webp" />
        </label>
      </div>
      <div id="thumbPreview" class="thumb-preview">${rec?.thumb ? `<img src="${rec.thumb}" alt=""/>` : ""}</div>
      <div class="btn-row"><button class="primary">${rec ? "保存缺陷" : "登记缺陷"}</button>${rec ? `<button type="button" id="defectEditCancel">取消编辑</button>` : ""}</div>
      <p class="hint">关键缺陷未闭环时，所属批次不能判通过、不能出现在任何付款单中。</p>`;
    const fileInput = $("#defectForm [name=thumb]");
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const safe = C.validateThumbData(reader.result, "");
          $("#thumbPreview").innerHTML = `<img src="${safe}" alt=""/><span class="tag ok">已校验：真实 ${file.type}（${file.size} 字节）</span>`;
          fileInput.dataset.dataurl = safe;
        } catch (err) {
          $("#thumbPreview").innerHTML = `<span class="tag damage">${esc(err.message)}</span>`;
          toast(err.message, "err");
          fileInput.value = "";
          delete fileInput.dataset.dataurl;
        }
      };
      reader.readAsDataURL(file);
    });
  }

  function renderDefects() {
    renderDefectForm();
    const s = store.state;
    const sev = $("#defectSeverityFilter").value;
    const stx = $("#defectStatusFilter").value;
    let list = s.defects;
    if (sev) list = list.filter((d) => d.severity === sev);
    if (stx) list = list.filter((d) => d.status === stx);
    const flow = { 待整改: ["已返工待复验"], 已返工待复验: ["闭环", "待整改"], 闭环: ["待整改"] };
    $("#defectList").innerHTML = list
      .map((d) => {
        const b = s.batches.find((x) => x.id === d.batchId);
        return `<div class="defect-card sev-${d.severity}">
          <div class="defect-head">
            <strong>${esc(d.code)}</strong>
            <span class="sev-tag sev-${d.severity}">${d.severity}</span>
            <span class="status-tag stx-${d.status}">${d.status}</span>
            <span class="muted">批次 ${esc(b ? b.code : "?")} · ${esc(d.type)}</span>
          </div>
          <p>${esc(d.description || "（无描述）")}</p>
          ${d.thumb ? `<img class="defect-thumb" src="${d.thumb}" alt="缺陷缩略图"/>` : ""}
          <div class="row-actions">
            ${(flow[d.status] || []).map((to) => `<button data-def-trans="${d.id}|${to}">→ ${to}</button>`).join("")}
            <button data-def-edit="${d.id}">编辑</button>
          </div>
        </div>`;
      })
      .join("") || `<p class="muted">没有符合条件的缺陷。</p>`;
  }

  $("#defectForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const fd = new FormData(f);
    const data = {
      id: ui.defectEditId || undefined,
      code: fd.get("code"),
      batchId: fd.get("batchId"),
      severity: fd.get("severity"),
      type: fd.get("type"),
      description: fd.get("description"),
      status: fd.get("status"),
      thumb: f.querySelector("[name=thumb]").dataset.dataurl ?? null
    };
    const r = commit({ type: "saveDefect", data });
    if (!r.errors.length) {
      ui.defectEditId = null;
      renderDefects();
    }
  });
  $("#defectList").addEventListener("click", (e) => {
    const t = e.target.closest("[data-def-trans]");
    const ed = e.target.closest("[data-def-edit]");
    if (t) {
      const [id, to] = t.dataset.defTrans.split("|");
      commit({ type: "transitionDefect", defectId: id, to }, `缺陷已更新为「${to}」`);
    }
    if (ed) {
      ui.defectEditId = ed.dataset.defEdit;
      renderDefects();
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("#defectEditCancel")) {
      ui.defectEditId = null;
      renderDefects();
    }
  });

  /* ============================================================
   * 付款台
   * ============================================================ */

  $("#paymentStatusFilter").innerHTML = `<option value="">全部状态</option>` + C.PAYMENT_STATUSES.map((x) => `<option>${x}</option>`).join("");
  $("#paymentStatusFilter").value = "";
  $("#paymentStatusFilter").addEventListener("change", renderPayments);
  $("#paymentSearch").addEventListener("input", renderPayments);

  function renderPayments() {
    const s = store.state;
    const kw = $("#paymentSearch").value.trim();
    const stf = $("#paymentStatusFilter").value;
    let list = s.payments;
    if (stf) list = list.filter((p) => p.status === stf);
    if (kw) list = list.filter((p) => p.code.includes(kw));
    $("#paymentList").innerHTML = list
      .map((p) => {
        const con = s.contracts.find((c) => c.id === p.contractId);
        const ms = s.milestones.find((m) => m.id === p.milestoneId);
        const needLevel = p.requiredLevel || C.requiredLevelFor(p.net || 0);
        return `<div class="pay-card pay-${p.status}">
          <div class="pay-head">
            <strong>${esc(p.code)}</strong>
            <span class="status-tag pay-${p.status}">${p.status}</span>
            <span class="muted">${esc(con ? con.code : "?")}${ms ? " · 节点 " + esc(ms.code) : ""}</span>
          </div>
          <div class="kv-grid">
            <span>产值 <b>${money(p.gross)}</b></span>
            <span>扣款 ${money(p.deductionsTotal)}</span>
            <span>保证金扣留 ${money(p.retention)}</span>
            <span>应付 <b>${money(p.net)}</b></span>
            <span>审批级别 ${p.approvals ? p.approvals.length : 0}/${needLevel}</span>
            <span>${p.paidAt ? "已付款 " + dtShort(p.paidAt) + " · " + esc(p.serial) : p.submittedAt ? "提交于 " + dtShort(p.submittedAt) : "草稿"}</span>
          </div>
          <div class="muted small">批次：${(p.batchIds || []).map((id) => esc((s.batches.find((b) => b.id === id) || {}).code)).join("、") || "—"}</div>
          ${p.rejectReason ? `<div class="crit-box">驳回原因：${esc(p.rejectReason)}</div>` : ""}
          <div class="row-actions">
            ${["草稿", "驳回"].includes(p.status) ? `<button data-pay-edit="${p.id}">编辑/提交</button>` : ""}
            ${p.status === "已批准" ? `<button data-pay-now="${p.id}" class="primary">确认付款（财务）</button>` : ""}
            ${["待审批", "审批中"].includes(p.status) ? `<button data-goto="approvals">去审批台</button>` : ""}
          </div>
        </div>`;
      })
      .join("") || `<p class="muted">还没有付款单。点击右上角「新建付款单」。</p>`;
    if (ui.paymentEditId) renderPaymentEditor();
    else $("#paymentEditor").classList.add("hidden");
  }

  $("#newPaymentBtn").addEventListener("click", () => openPaymentEditor(null));
  $("#paymentList").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-pay-edit]");
    const now = e.target.closest("[data-pay-now]");
    if (ed) openPaymentEditor(ed.dataset.payEdit);
    if (now) {
      const serial = window.prompt("输入付款流水号（留空自动生成）", "");
      if (serial === null) return;
      commit({ type: "payPayment", paymentId: now.dataset.payNow, serial: serial.trim() }, "付款成功");
    }
  });
  $("#closePaymentBtn").addEventListener("click", () => {
    if (confirm2("收起编辑器？未提交内容保留为本地草稿，可在导入导出页恢复。")) {
      ui.paymentEditId = null;
      ui.pf = null;
      renderPayments();
    }
  });

  function draftKey(id) {
    return "payment:" + (id || "new:" + store.pageId);
  }

  function openPaymentEditor(id) {
    const s = store.state;
    if (id) {
      const got = store.acquireLock("payment", id);
      if (!got.ok) {
        toast(`付款单正被 ${got.holder.tabName}（${got.holder.by}）编辑，双页竞争已拦截`, "err");
        return;
      }
      const p = s.payments.find((x) => x.id === id);
      ui.pf = {
        id: p.id,
        code: p.code,
        contractId: p.contractId,
        milestoneId: p.milestoneId || "",
        batchIds: new Set(p.batchIds),
        deductions: structuredClone(p.deductions || []),
        note: p.note || ""
      };
    } else {
      const draft = store.loadDraft(draftKey(null));
      ui.pf = draft
        ? Object.assign({}, draft, { batchIds: new Set(draft.batchIds || []) })
        : newPf();
      if (draft) toast("已恢复上次未提交的付款草稿", "ok");
    }
    ui.paymentEditId = id || "new";
    renderPayments();
  }
  function newPf() {
    const s = store.state;
    return { id: null, code: "PAY-" + String(s.payments.length + 1).padStart(3, "0"), contractId: s.contracts[0]?.id || "", milestoneId: "", batchIds: new Set(), deductions: [{ reason: "", amount: 0 }], note: "" };
  }

  function renderPaymentEditor() {
    const s = store.state;
    const pf = ui.pf;
    if (!pf) return;
    const editor = $("#paymentEditor");
    editor.classList.remove("hidden");
    $("#paymentEditorTitle").textContent = pf.id ? "编辑付款单 " + pf.code : "新建付款单";
    const contractBatches = s.batches.filter((b) => {
      const reel = s.reels.find((r) => r.id === b.reelId);
      return reel && reel.contractId === pf.contractId;
    });
    const con = s.contracts.find((c) => c.id === pf.contractId);
    $("#paymentForm").innerHTML = `
      <div class="form-grid-4">
        <label>付款单号 *<input name="code" value="${esc(pf.code)}" /></label>
        <label>合同 *<select name="contractId">${options(s.contracts, pf.contractId, "请选择")}</select></label>
        <label>付款节点<select name="milestoneId">${options(s.milestones.filter((m) => m.contractId === pf.contractId), pf.milestoneId, "不绑定节点")}</select></label>
        <label>发起人<div class="inline-help">${esc(store.userName)}（${C.ROLES[store.role].name}）<br><span id="capHint"></span></div></label>
      </div>
      <fieldset class="check-group">
        <legend>计入本单的批次（仅「通过」且无未闭环关键缺陷、且未被其他在途单使用的批次可勾选）</legend>
        <div class="batch-pick">
          ${contractBatches
            .map((b) => {
              const crit = C.openCriticalDefectIds(s, b.id).length;
              const used = s.payments.find((q) => q.id !== pf.id && ["草稿", "待审批", "审批中", "已批准", "已付款"].includes(q.status) && (q.batchIds || []).includes(b.id));
              const disabled = b.status !== "通过" || crit || used;
              const why = b.status !== "通过" ? `状态 ${b.status}` : crit ? "有关键缺陷" : used ? "已在 " + used.code : `${b.passedFrames} 合格画幅`;
              return `<label class="check ${disabled ? "disabled" : ""}"><input type="checkbox" name="batch" value="${b.id}" ${pf.batchIds.has(b.id) ? "checked" : ""} ${disabled ? "disabled" : ""}/> ${esc(b.code)} <span class="muted">${esc(why)}</span></label>`;
            })
            .join("") || `<span class="muted">该合同下暂无批次</span>`}
        </div>
      </fieldset>
      <h3 class="subhead">扣款（不合格/违约等）</h3>
      <div id="deductionRows"></div>
      <button type="button" id="addDeductionBtn">＋ 增加扣款行</button>
      <label class="mt8">备注<textarea name="note" rows="2">${esc(pf.note)}</textarea></label>
      <div id="paySummary" class="pay-summary"></div>
      <div class="btn-row">
        <button type="button" id="submitPayBtn" class="primary">校验并提交审批</button>
        <button type="button" id="draftPayBtn">暂存草稿（不占预算）</button>
      </div>
      <p class="hint">提交时统一校验：关键缺陷拦截、重复付款、合同预算、节点额度、前置节点、验收比例、保证金扣留与多级审批级别。</p>`;

    // 角色额度提示
    const cap = C.ROLES[store.role].limits.paymentCreate;
    $("#capHint").textContent = ["pm", "finance"].includes(store.role) ? `本角色发起上限 ${money(cap)}（管理员不限，质检员不能发起）` : store.role === "qc" ? "质检员不能发起付款单" : "";

    renderDeductionRows();
    renderPaySummary();
  }

  /* 付款编辑器事件（容器稳定，只绑定一次，靠事件委托） */
  $("#paymentForm").addEventListener("input", (e) => {
    if (!ui.pf) return;
    const pf = ui.pf;
    const t = e.target;
    if (t.name === "code") pf.code = t.value;
    if (t.name === "note") pf.note = t.value;
    const d = t.dataset && t.dataset.deduct;
    if (d) {
      const i = Number(t.dataset.i);
      pf.deductions[i][d] = d === "amount" ? Number(t.value) : t.value;
      renderPaySummary();
    }
    if (t.name === "code" || t.name === "note") saveDraft();
  });
  $("#paymentForm").addEventListener("change", (e) => {
    if (!ui.pf) return;
    const pf = ui.pf;
    const t = e.target;
    if (t.name === "contractId") {
      pf.contractId = t.value;
      pf.milestoneId = "";
      pf.batchIds = new Set();
      saveDraft();
      renderPaymentEditor();
      return;
    }
    if (t.name === "milestoneId") {
      pf.milestoneId = t.value;
      saveDraft();
      renderPaySummary();
      return;
    }
    if (t.name === "batch") {
      if (t.checked) pf.batchIds.add(t.value);
      else pf.batchIds.delete(t.value);
      saveDraft();
      renderPaySummary();
    }
  });
  $("#paymentForm").addEventListener("click", (e) => {
    const add = e.target.closest("#addDeductionBtn");
    const del = e.target.closest("[data-deduct-del]");
    const submit = e.target.closest("#submitPayBtn");
    const draft = e.target.closest("#draftPayBtn");
    if (add) {
      ui.pf.deductions.push({ reason: "", amount: 0 });
      renderDeductionRows();
      renderPaySummary();
    }
    if (del) {
      ui.pf.deductions.splice(Number(del.dataset.deductDel), 1);
      renderDeductionRows();
      renderPaySummary();
      saveDraft();
    }
    if (submit) savePayment(true);
    if (draft) savePayment(false);
  });

  function renderDeductionRows() {
    const pf = ui.pf;
    $("#deductionRows").innerHTML = pf.deductions
      .map(
        (d, i) => `<div class="deduct-row">
        <input placeholder="扣款原因" data-deduct="reason" data-i="${i}" value="${esc(d.reason)}" />
        <input placeholder="金额" type="number" step="0.01" min="0" data-deduct="amount" data-i="${i}" value="${d.amount || ""}" />
        <button type="button" data-deduct-del="${i}">移除</button>
      </div>`
      )
      .join("");
  }

  function renderPaySummary() {
    const pf = ui.pf;
    if (!pf) return;
    const s = store.state;
    const tmp = {
      id: pf.id || "__tmp__",
      code: pf.code,
      contractId: pf.contractId,
      milestoneId: pf.milestoneId,
      batchIds: Array.from(pf.batchIds),
      deductions: pf.deductions.filter((d) => d.reason || d.amount),
      note: pf.note
    };
    let amounts = { gross: 0, deductions: 0, retention: 0, net: 0 };
    let errs = ["请先选择合同"];
    if (s.contracts.find((c) => c.id === pf.contractId)) {
      amounts = C.computePaymentAmounts(s, tmp);
      errs = C.validatePaymentState(s, tmp, { commit: true }).map((x) => x.replace(/^拒绝：/, ""));
    }
    const steps = C.requiredSteps(amounts.net);
    $("#paySummary").innerHTML = `
      <div class="pay-amounts">
        <span>合格画幅产值 <b>${money(amounts.gross)}</b></span>
        <span>扣款合计 ${money(amounts.deductions)}</span>
        <span>保证金扣留 ${money(amounts.retention)}</span>
        <span class="big">应付 <b>${money(amounts.net)}</b></span>
      </div>
      <div class="pay-rule">
        <div class="${errs.length ? "rules-bad" : "rules-ok"}">
          ${errs.length ? errs.map((x) => `<div>✗ ${esc(x)}</div>`).join("") : "<div>✓ 全部硬约束通过，可以提交</div>"}
        </div>
        <div class="muted small">提交后审批链：${steps.map((x) => x.label + "（≤" + money(x.max) + "）").join(" → ")}；提交人不能自审。</div>
      </div>`;
  }

  function saveDraft() {
    if (!ui.pf) return;
    const pf = ui.pf;
    store.saveDraft(draftKey(pf.id), {
      id: pf.id,
      code: pf.code,
      contractId: pf.contractId,
      milestoneId: pf.milestoneId,
      batchIds: Array.from(pf.batchIds),
      deductions: pf.deductions,
      note: pf.note
    });
  }

  function savePayment(submit) {
    const pf = ui.pf;
    const data = {
      id: pf.id || undefined,
      code: pf.code,
      contractId: pf.contractId,
      milestoneId: pf.milestoneId,
      batchIds: Array.from(pf.batchIds),
      deductions: pf.deductions.filter((d) => d.reason || d.amount),
      note: pf.note
    };
    // 前端提前算净额，用于角色额度拦截演示
    const tmp = Object.assign({ id: pf.id || "__tmp__" }, data);
    const amounts = C.computePaymentAmounts(store.state, tmp);
    data.tentativeNet = amounts.net;
    const r = commit({ type: "savePayment", data, submit }, submit ? "已提交审批" : "草稿已暂存");
    if (!r.errors.length) {
      store.clearDraft(draftKey(pf.id));
      if (pf.id) store.releaseLock("payment", pf.id);
      ui.pf = null;
      ui.paymentEditId = null;
      renderPayments();
    }
  }

  /* ============================================================
   * 审批台
   * ============================================================ */

  function renderApprovals() {
    const s = store.state;
    $("#approvalRoleHint").textContent = `当前身份：${store.userName}（${C.ROLES[store.role].name}）。顺序审批，不能自审/越级/重复审。`;
    const active = s.payments.filter((p) => ["待审批", "审批中", "已批准"].includes(p.status));
    $("#approvalList").innerHTML = active
      .map((p) => {
        const con = s.contracts.find((c) => c.id === p.contractId);
        const needLevel = p.requiredLevel || C.requiredLevelFor(p.net);
        const steps = C.requiredSteps(p.net);
        const done = new Set((p.approvals || []).map((a) => a.level));
        const chain = steps
          .map((st) => {
            const sign = (p.approvals || []).find((a) => a.level === st.level);
            return `<li class="${done.has(st.level) ? "done" : "todo"}">级别 ${st.level} · ${st.label} ${sign ? `✓ ${esc(sign.by)} ${dtShort(sign.at)}` : "（待签）"}</li>`;
          })
          .join("");
        return `<div class="approval-card pay-${p.status}">
          <div class="pay-head">
            <strong>${esc(p.code)}</strong><span class="status-tag pay-${p.status}">${p.status}</span>
            <span class="muted">${esc(con ? con.code : "")} · 提交人 ${esc(p.submittedBy || "?")} ${p.submittedAt ? "· " + dtShort(p.submittedAt) : ""}</span>
          </div>
          <div class="kv-grid">
            <span>产值 ${money(p.gross)}</span><span>扣款 ${money(p.deductionsTotal)}</span><span>保证金 ${money(p.retention)}</span><span class="big">应付 ${money(p.net)}</span>
          </div>
          <ol class="chain">${chain}</ol>
          <div class="row-actions">
            ${p.status !== "已批准" ? `<button data-approve="${p.id}" class="primary">通过（以当前角色签署下一级）</button><button data-reject="${p.id}">驳回</button>` : `<button data-pay-now="${p.id}" class="primary">确认付款（财务）</button>`}
          </div>
        </div>`;
      })
      .join("") || `<p class="muted">当前没有待审批或待付款的单据。</p>`;
  }

  $("#approvalList").addEventListener("click", (e) => {
    const ap = e.target.closest("[data-approve]");
    const rj = e.target.closest("[data-reject]");
    const pn = e.target.closest("[data-pay-now]");
    if (ap) commit({ type: "approvePayment", paymentId: ap.dataset.approve }, "已签署");
    if (rj) {
      const reason = window.prompt("驳回原因", "资料不全");
      if (reason === null) return;
      commit({ type: "rejectPayment", paymentId: rj.dataset.reject, reason: reason.trim() || "未说明" }, "已驳回");
    }
    if (pn) {
      const serial = window.prompt("付款流水号（留空自动生成）", "");
      if (serial === null) return;
      commit({ type: "payPayment", paymentId: pn.dataset.payNow, serial: serial.trim() }, "付款成功");
    }
  });

  /* ============================================================
   * 审计 + 版本
   * ============================================================ */

  function renderAuditRows(rows) {
    if (!rows.length) return `<p class="muted">暂无审计记录。</p>`;
    return `<table class="audit-table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>结果</th></tr></thead><tbody>
      ${rows
        .map((a) => `<tr class="res-${a.result || "ok"}">
          <td>${dt(a.at)}</td><td>${esc(a.byName || a.actor)}<div class="muted small">${esc(C.ROLES[a.role] ? C.ROLES[a.role].name : a.role)}</div></td>
          <td>${esc(a.action)}</td><td>${esc(a.target)}</td><td class="detail">${esc(a.detail || "")}${a.reason ? `<div class="reason">${esc(a.reason)}</div>` : ""}</td>
          <td><span class="res-tag ${a.result || "ok"}">${a.result === "denied" ? "拒绝" : a.result === "conflict" ? "冲突" : "成功"}</span></td>
        </tr>`)
        .join("")}
    </tbody></table>`;
  }

  $("#auditSearch").addEventListener("input", renderHistory);
  $("#auditResultFilter").addEventListener("change", renderHistory);

  function renderHistory() {
    const s = store.state;
    const kw = $("#auditSearch").value.trim();
    const rf = $("#auditResultFilter").value;
    let rows = s.audit;
    if (rf) rows = rows.filter((a) => (a.result || "ok") === rf);
    if (kw) rows = rows.filter((a) => `${a.action}${a.target}${a.actor}${a.detail}${a.reason}`.includes(kw));
    $("#auditList").innerHTML = renderAuditRows(rows.slice(0, 300));

    $("#undoBtn").disabled = !store.canUndo();
    $("#redoBtn").disabled = !store.canRedo();
    const top = store.canUndo() ? store.undoStack[store.undoStack.length - 1] : null;
    $("#undoHint").textContent = top ? `上一步：${top.label}（该步之后若有其他页面改动，撤销会被拒绝并提示走版本回滚）` : "没有可撤销的操作；所有成功的写操作都可撤销，拒绝的操作不改数据。";

    $("#snapshotList").innerHTML = store
      .listSnapshots()
      .map(
        (sn) => `<div class="snap-row">
        <div><strong>${esc(sn.label)}</strong>${sn.manual ? '<span class="tag">手动</span>' : ""}<br><span class="muted small">${sn.at} · rev ${sn.rev} · ${esc(sn.by)}</span></div>
        <button data-rollback="${sn.id}" class="danger-text">回滚到此版本</button>
      </div>`
      )
      .join("") || `<p class="muted">每 5 次写操作自动产生一个版本点，也可手动打点。</p>`;
  }

  $("#undoBtn").addEventListener("click", () => store.undo());
  $("#redoBtn").addEventListener("click", () => store.redo());
  $("#snapshotBtn").addEventListener("click", () => {
    store.takeSnapshot("手动版本点");
    toast("版本点已保存", "ok");
    renderHistory();
  });
  $("#snapshotList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rollback]");
    if (!b) return;
    if (!confirm2("确认回滚到该版本？当前状态会先自动备份为一个新版本点。")) return;
    const r = store.rollback(b.dataset.rollback);
    if (!r.errors.length) toast("已回滚，回滚前状态已备份", "ok");
  });
  $("#resetDemoBtn").addEventListener("click", () => {
    if (!confirm2("确认重置为演示数据？当前全部数据会先自动备份，可在版本列表回滚恢复。")) return;
    store.resetToDemo();
    toast("已重置（回滚前自动备份已保存）", "ok");
  });

  /* ============================================================
   * 导入 / 导出 / 草稿
   * ============================================================ */

  $("#importFile").addEventListener("change", () => {
    const file = $("#importFile").files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => ($("#importText").value = reader.result);
    reader.readAsText(file, "utf-8");
  });

  $("#importForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#importText").value.trim();
    if (!text) return toast("请先选择文件或粘贴 JSON", "err");
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      $("#importResult").innerHTML = `<div class="import-bad">✗ JSON 解析失败：${esc(err.message)}</div><p class="hint">整包拒绝，未写入任何记录。</p>`;
      return;
    }
    // 先展示完整校验明细（含全部行号），再走带审计的提交
    const allErrors = C.validateImport(store.state, payload, store.ctx());
    const r = commit({ type: "importBundle", payload: text });
    const box = $("#importResult");
    if (!r.errors.length) {
      const counts = r.events.find((x) => x.type === "imported").counts;
      box.innerHTML = `<div class="import-ok">✓ 导入成功：${Object.entries(counts)
        .map(([k, v]) => `${v} ${({ vendors: "外包商", contracts: "合同", reels: "胶片卷", batches: "批次", defects: "缺陷", milestones: "付款节点" })[k]}`)
        .join("，")}。整包通过校验，无重复/循环/非法值。</div>`;
      toast("导入成功", "ok");
      $("#importText").value = "";
      $("#importFile").value = "";
    } else {
      const list = allErrors.length ? allErrors : [r.errors[0].message.replace(/^拒绝：/, "")];
      box.innerHTML = `<div class="import-bad">✗ 导入被整体拒绝（${list.length} 个问题，没有任何记录被写入）：</div>
        <ol class="import-errors">${list.slice(0, 50).map((x) => `<li>${esc(x)}</li>`).join("")}${list.length > 50 ? `<li>……另有 ${list.length - 50} 条</li>` : ""}</ol>
        <p class="hint">请按行号修正后重新导入。本次拒绝已写入操作审计。</p>`;
    }
  });

  $("#exportJsonBtn").addEventListener("click", () => {
    const s = store.state;
    const codeOf = (list, id) => (list.find((x) => x.id === id) || {}).code || "";
    const payload = {
      vendors: s.vendors.map((v) => ({ code: v.code, name: v.name, contact: v.contact, disabled: v.disabled })),
      contracts: s.contracts.map((c) => ({
        code: c.code, name: c.name, vendorCode: codeOf(s.vendors, c.vendorId),
        budget: c.budget, unitPrice: c.unitPrice, retentionRate: c.retentionRate, minPassRatio: c.minPassRatio,
        startDate: c.startDate, endDate: c.endDate
      })),
      reels: s.reels.map((r) => ({ code: r.code, name: r.name, contractCode: codeOf(s.contracts, r.contractId), totalFrames: r.totalFrames, prevReelCode: codeOf(s.reels, r.prevReelId) })),
      batches: s.batches.map((b) => ({ code: b.code, reelCode: codeOf(s.reels, b.reelId), frames: b.frames, scannedAt: b.scannedAt, operator: b.operator, status: b.status })),
      defects: s.defects.map((d) => ({ code: d.code, batchCode: codeOf(s.batches, d.batchId), severity: d.severity, type: d.type, description: d.description, status: d.status })),
      milestones: s.milestones.map((m) => ({ code: m.code, name: m.name, contractCode: codeOf(s.contracts, m.contractId), amount: m.amount, dueDate: m.dueDate, prereqCodes: (m.prereqIds || []).map((id) => codeOf(s.milestones, id)) }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "digitdesk-records-" + C.today() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  function renderDrafts() {
    const drafts = store.listDrafts();
    $("#draftList").innerHTML = drafts.length
      ? drafts
          .map(
            (d) => `<div class="draft-row">
          <div><strong>${esc(d.key)}</strong><br><span class="muted small">${new Date(d.at).toLocaleString("zh-CN", { hour12: false })} · 来自 ${d.pageId === store.pageId ? "本页" : "另一页面 " + d.pageId}</span></div>
          <div class="row-actions">${d.key.startsWith("payment:") ? `<button data-draft-recover="${esc(d.key)}">恢复到付款台</button>` : ""}<button data-draft-drop="${esc(d.key)}" class="danger-text">丢弃</button></div>
        </div>`
          )
          .join("")
      : `<p class="muted">没有未提交草稿。付款单编辑内容会实时存草稿，刷新页面后可恢复。</p>`;
  }
  document.addEventListener("click", (e) => {
    const rec = e.target.closest("[data-draft-recover]");
    const drop = e.target.closest("[data-draft-drop]");
    if (rec) {
      const key = rec.dataset.draftRecover;
      const draft = store.loadDraft(key);
      if (!draft) return;
      ui.pf = Object.assign({}, draft, { batchIds: new Set(draft.batchIds || []) });
      ui.paymentEditId = draft.id || "new";
      $("#tabs").querySelector('[data-tab="payments"]').click();
      renderPayments();
    }
    if (drop) {
      store.clearDraft(drop.dataset.draftDrop);
      renderDrafts();
    }
    const rl = e.target.closest("[data-release-lock]");
    if (rl) {
      const [entity, id] = rl.dataset.releaseLock.split("|");
      store.releaseLock(entity, id);
      renderAll();
    }
  });

  $("#loadSampleGoodBtn").addEventListener("click", () => {
    $("#importText").value = JSON.stringify(
      {
        vendors: [{ code: "V-样例", name: "样例数字化公司", contact: "010-88888888" }],
        contracts: [{ code: "HT-S-01", name: "样例合同", vendorCode: "V-样例", budget: 50000, unitPrice: 1, retentionRate: 0.05, minPassRatio: 0, startDate: "2026-01-01", endDate: "2026-12-31" }],
        reels: [{ code: "R-S-01", name: "样例卷", contractCode: "HT-S-01", totalFrames: 3000, prevReelCode: "" }],
        batches: [{ code: "B-S-01", reelCode: "R-S-01", frames: 2000, scannedAt: "2026-05-01", operator: "样例员" }],
        defects: [{ code: "D-S-01", batchCode: "B-S-01", severity: "一般", type: "轻微划痕", description: "不影响使用", status: "闭环" }],
        milestones: [{ code: "MS-S-01", contractCode: "HT-S-01", name: "样例首款", amount: 20000, dueDate: "2026-07-01", prereqCodes: [] }]
      },
      null,
      2
    );
  });

  $("#loadSampleBadBtn").addEventListener("click", () => {
    // 一个文件同时触发五类拦截：重复编号 / 循环引用 / 非法日期 / 非法金额 / 越权记录 / 伪装缩略图
    const fakePng = "data:image/png;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    $("#importText").value = JSON.stringify(
      {
        vendors: [{ code: "DUP-1", name: "甲" }, { code: "DUP-1", name: "乙（包内重复编号）" }],
        contracts: [{ code: "C-BAD", vendorCode: "DUP-1", budget: "壹万元（非法金额）", unitPrice: 1, startDate: "2026-13-40", endDate: "2026-02-29" }],
        reels: [
          { code: "R-1", contractCode: "C-BAD", totalFrames: 100, prevReelCode: "R-3" },
          { code: "R-2", contractCode: "C-BAD", totalFrames: 100, prevReelCode: "R-1" },
          { code: "R-3", contractCode: "C-BAD", totalFrames: 100, prevReelCode: "R-2" }
        ],
        batches: [{ code: "B-X", reelCode: "R-1", frames: 99999, scannedAt: "2026/05/01" }],
        defects: [{ code: "DF-1", batchCode: "B-X", severity: "关键", thumb: fakePng }],
        milestones: [{ code: "M-1", contractCode: "C-BAD", amount: 1000, prereqCodes: ["M-2"] }, { code: "M-2", contractCode: "C-BAD", amount: 1000, prereqCodes: ["M-1"] }],
        payments: [{ code: "PAY-FORBIDDEN", note: "夹带付款单（越权记录，必须拒绝）" }]
      },
      null,
      2
    );
  });

  /* ============================================================
   * 总渲染
   * ============================================================ */

  function renderAll() {
    $("#revBadge").textContent = "rev " + store.rev;
    const pending = store.state.payments.filter((p) => ["待审批", "审批中"].includes(p.status)).length;
    const badge = $("#approveBadge");
    badge.textContent = pending;
    badge.classList.toggle("hidden", pending === 0);
    if (ui.tab === "dashboard") renderDashboard();
    if (ui.tab === "records") renderRecords();
    if (ui.tab === "acceptance") renderBatches();
    if (ui.tab === "defects") renderDefects();
    if (ui.tab === "payments") renderPayments();
    if (ui.tab === "approvals") renderApprovals();
    if (ui.tab === "history") renderHistory();
    if (ui.tab === "io") renderDrafts();
  }

  initRoleBar();
  initBatchFilters();
  renderAll();

  // 调试 / 自动化测试句柄（离线内部工具）
  window.__digitdesk = { store, ui, renderAll, commit };

  // 首次进入若有付款草稿，提示一次（刷新恢复）
  setTimeout(() => {
    const drafts = store.listDrafts().filter((d) => d.key.startsWith("payment:"));
    if (drafts.length) toast(`检测到 ${drafts.length} 份未提交的付款草稿，已保留；可在「导入导出」页或新建付款单时恢复`, "ok");
  }, 400);
})();
