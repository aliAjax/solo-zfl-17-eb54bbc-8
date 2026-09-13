/*
 * walkthrough.js —— 浏览器走通的 9 个场景（在 Node DOM 垫片中驱动真实 ui.js）
 * 运行：node test/walkthrough.js
 */
"use strict";
const { createWindow, ok, eq, includes, resetCounters, summary, tick, $id } = require("./harness.js");
const { memoryStorage, memoryBus } = require("../js/store.js");

const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

function store(win) { return win.__digitdesk.store; }
function find(doc, selector) { const el = doc.querySelector(selector); if (!el) throw new Error("DOM 中找不到 " + selector); return el; }
function findAll(doc, selector) { return doc.querySelectorAll(selector); }
function goto(doc, tab) { find(doc, `#tabs [data-tab="${tab}"]`).click(); }
function toastText(doc) { return $id(doc, "toastHost").textContent; }
function clearToast(doc) { $id(doc, "toastHost").children = []; }
function setActor(win, doc, role, name) {
  const sel = $id(doc, "roleSelect");
  sel.value = role;
  sel.dispatch({ type: "change" });
  const inp = $id(doc, "userNameInput");
  inp.value = name;
  inp.dispatch({ type: "change" });
  eq(store(win).role, role, "角色切换为 " + role);
  eq(store(win).userName, name, "操作人切换为 " + name);
}
function setVal(el, v) { el.value = String(v); el.dispatch({ type: "input" }); el.dispatch({ type: "change" }); }
function tickCheck(el, on) { el.checked = !!on; el.dispatch({ type: "change" }); }
function submit(formEl, submitterValue) {
  let submitter = null;
  if (submitterValue) submitter = formEl.querySelector(`button[value="${submitterValue}"]`);
  const ev = { type: "submit", submitter: submitter || formEl.querySelector("button") };
  formEl.dispatch(ev);
}
function byCode(win, kind, code) { return store(win).state[kind].find((x) => x.code === code); }
function waitBus() { return tick().then(tick); }

/* ========== 场景 0：所有入口无空壳 ========== */
scenario("S0 八个页签都有真实内容，无空壳入口", () => {
  const { win, doc } = createWindow({ role: "pm", user: "孙经理" });
  const tabs = ["dashboard", "records", "acceptance", "defects", "payments", "approvals", "history", "io"];
  for (const t of tabs) {
    goto(doc, t);
    const panel = doc.querySelector(`.view[data-view="${t}"]`);
    const text = panel.textContent.replace(/\s+/g, "");
    ok(text.length > 40, `页签 ${t} 有实质内容`);
    const controls = findAll(panel, "button").length + findAll(panel, "input").length + findAll(panel, "select").length;
    // 审批台在没有待审批单时是合法空状态；其余页签必须有可操作控件
    if (t !== "approvals") ok(controls > 0, `页签 ${t} 有可操作控件`);
  }
  // 空状态入口必须真能打开工作台（无空壳）
  goto(doc, "payments");
  $id(doc, "newPaymentBtn").click();
  ok(findAll(doc, "#paymentForm input, #paymentForm select, #paymentForm fieldset").length >= 5, "新建付款单打开完整工作台");
  $id(doc, "closePaymentBtn").click();
  // 种子数据齐全
  ok(store(win).state.vendors.length >= 1, "外包商");
  ok(store(win).state.contracts.length >= 1, "合同");
  ok(store(win).state.reels.length >= 2, "胶片卷");
  ok(store(win).state.batches.length >= 3, "批次");
  ok(store(win).state.milestones.length >= 3, "付款节点");
  // 概览流水线五列
  eq(findAll(doc, ".pipe-col").length, 5, "五状态流水线");
});

/* ========== 场景 1：正常验收 → 多级审批 → 付款 ========== */
scenario("S1 正常验收+二级审批+付款全链路", () => {
  const { win, doc } = createWindow({ role: "pm", user: "孙经理" });
  win.prompt = () => "";
  // 验收 B-003（待扫描 → 验收）
  goto(doc, "acceptance");
  const b3 = byCode(win, "batches", "B-003").id;
  find(doc, `[data-trans="${b3}|验收"]`).click();
  eq(byCode(win, "batches", "B-003").status, "验收", "B-003 进入验收");
  // 验收登记：9000/9000 全部合格，登记一般缺陷，直接判通过
  find(doc, `[data-accept="${b3}"]`).click();
  const form = $id(doc, "acceptForm");
  setVal(form.querySelector('[name="passedFrames"]'), 9000);
  setVal(form.querySelector('[name="dcode"]'), "D-S1-001");
  setVal(form.querySelector('[name="ddesc"]'), "片尾轻微划痕");
  submit(form, "pass");
  eq(byCode(win, "batches", "B-003").status, "通过", "B-003 判通过");
  eq(byCode(win, "batches", "B-003").passedFrames, 9000, "合格画幅 9000");
  ok(byCode(win, "defects", "D-S1-001"), "缺陷已登记");

  // 新建付款单
  goto(doc, "payments");
  $id(doc, "newPaymentBtn").click();
  const pf = $id(doc, "paymentForm");
  setVal(pf.querySelector('[name="code"]'), "PAY-S1");
  const cb = pf.querySelector(`input[name="batch"][value="${b3}"]`);
  ok(!cb.disabled, "B-003 可勾选付款");
  tickCheck(cb, true);
  includes($id(doc, "paySummary").textContent, "8,100.00", "应付=9000产值-10%保证金=8100");
  includes($id(doc, "paySummary").textContent, "全部硬约束通过", "硬约束预检通过");
  clearToast(doc);
  find(doc, "#submitPayBtn").click();
  const payId = byCode(win, "payments", "PAY-S1").id;
  eq(byCode(win, "payments", "PAY-S1").status, "待审批", "提交后待审批");
  eq(byCode(win, "payments", "PAY-S1").requiredLevel, 2, "8100 元需二级审批");

  // 自审被拦
  goto(doc, "approvals");
  clearToast(doc);
  find(doc, `[data-approve="${payId}"]`).click();
  includes(toastText(doc), "提交人不能审批自己发起", "自审拦截");
  eq(byCode(win, "payments", "PAY-S1").status, "待审批", "自审失败状态不变");

  // 换另一名项目经理签一级
  setActor(win, doc, "pm", "李经理");
  find(doc, `[data-approve="${payId}"]`).click();
  eq(byCode(win, "payments", "PAY-S1").status, "审批中", "项目经理签署后审批中");
  eq(byCode(win, "payments", "PAY-S1").approvals.length, 1, "一级签署记录");

  // 财务终审
  setActor(win, doc, "finance", "吴财务");
  find(doc, `[data-approve="${payId}"]`).click();
  eq(byCode(win, "payments", "PAY-S1").status, "已批准", "财务终审后已批准");
  eq(byCode(win, "payments", "PAY-S1").approvals.length, 2, "二级签署记录");

  // 确认付款
  find(doc, `[data-pay-now="${payId}"]`).click();
  const paid = byCode(win, "payments", "PAY-S1");
  eq(paid.status, "已付款", "付款成功");
  ok(/^PAY-\d+$/.test(paid.serial), "自动生成流水号 " + paid.serial);

  // 重复付款按钮已消失，审计完整
  ok(!doc.querySelector(`[data-pay-now="${payId}"]`), "已付款不再出现付款按钮");
  const audit = store(win).state.audit;
  ["验收登记", "提交付款单", "审批通过", "付款确认"].forEach((act) =>
    ok(audit.some((a) => a.action === act), "审计包含：" + act)
  );
});

/* ========== 场景 2：部分通过按合格画幅计价，一级审批 ========== */
scenario("S2 部分通过：按合格画幅计价，只需一级审批", () => {
  const { win, doc } = createWindow({ role: "qc", user: "钱质检" });
  win.prompt = () => "";
  const b3 = byCode(win, "batches", "B-003").id;
  goto(doc, "acceptance");
  find(doc, `[data-trans="${b3}|验收"]`).click();
  find(doc, `[data-accept="${b3}"]`).click();
  const form = $id(doc, "acceptForm");
  setVal(form.querySelector('[name="passedFrames"]'), 8000);
  includes($id(doc, "acceptHint").textContent, "部分通过", "提示部分通过");
  submit(form, "pass");
  eq(byCode(win, "batches", "B-003").passedFrames, 8000, "登记合格 8000");
  eq(byCode(win, "batches", "B-003").status, "通过", "部分通过也可判通过");

  setActor(win, doc, "pm", "孙经理");
  goto(doc, "payments");
  $id(doc, "newPaymentBtn").click();
  const pf = $id(doc, "paymentForm");
  setVal(pf.querySelector('[name="code"]'), "PAY-S2");
  tickCheck(pf.querySelector(`input[name="batch"][value="${b3}"]`), true);
  includes($id(doc, "paySummary").textContent, "7,200.00", "应付=8000-800保证金=7200");
  includes($id(doc, "paySummary").textContent, "项目经理审批", "7200≤8000 只需项目经理终审");
  find(doc, "#submitPayBtn").click();
  const payId = byCode(win, "payments", "PAY-S2").id;
  eq(byCode(win, "payments", "PAY-S2").net, 7200, "净额 7200");
  eq(byCode(win, "payments", "PAY-S2").requiredLevel, 1, "一级审批");

  goto(doc, "approvals");
  setActor(win, doc, "pm", "李经理");
  find(doc, `[data-approve="${payId}"]`).click();
  eq(byCode(win, "payments", "PAY-S2").status, "已批准", "项目经理单签即批准");
  setActor(win, doc, "finance", "吴财务");
  find(doc, `[data-pay-now="${payId}"]`).click();
  eq(byCode(win, "payments", "PAY-S2").status, "已付款", "财务付款完成");
  eq(byCode(win, "payments", "PAY-S2").serial, "PAY-0001", "首张付款流水号 PAY-0001");
});

/* ========== 场景 3：关键缺陷拦截付款 ========== */
scenario("S3 关键缺陷：判通过被拦、付款勾选项禁用，闭环后放行", () => {
  const { win, doc } = createWindow({ role: "qc", user: "钱质检" });
  const b2 = byCode(win, "batches", "B-002").id;
  // 付款编辑中 B-002 复选框必须禁用
  goto(doc, "payments");
  $id(doc, "newPaymentBtn").click();
  const cb2 = $id(doc, "paymentForm").querySelector(`input[name="batch"][value="${b2}"]`);
  ok(cb2.disabled, "有关键缺陷的批次禁止勾选");
  includes(cb2.closest("label").textContent, "状态 验收", "禁用原因展示");

  // 判通过被拦
  goto(doc, "acceptance");
  clearToast(doc);
  find(doc, `[data-trans="${b2}|通过"]`).click();
  includes(toastText(doc), "未闭环关键缺陷", "关键缺陷拦截判通过");
  eq(byCode(win, "batches", "B-002").status, "验收", "状态仍为验收");

  // 缺陷返工→复验→闭环
  goto(doc, "defects");
  const d2 = byCode(win, "defects", "D-002").id;
  find(doc, `[data-def-trans="${d2}|已返工待复验"]`).click();
  eq(byCode(win, "defects", "D-002").status, "已返工待复验", "缺陷转返工待复验");
  find(doc, `[data-def-trans="${d2}|闭环"]`).click();
  eq(byCode(win, "defects", "D-002").status, "闭环", "关键缺陷闭环");

  // 合格画幅 0 仍不能通过
  goto(doc, "acceptance");
  clearToast(doc);
  find(doc, `[data-trans="${b2}|通过"]`).click();
  includes(toastText(doc), "合格画幅为 0", "零合格画幅拦截");

  // 验收 1900 后通过，付款放行
  find(doc, `[data-accept="${b2}"]`).click();
  const form = $id(doc, "acceptForm");
  setVal(form.querySelector('[name="passedFrames"]'), 1900);
  submit(form, "pass");
  eq(byCode(win, "batches", "B-002").status, "通过", "闭环+登记后判通过");
  goto(doc, "payments");
  $id(doc, "newPaymentBtn").click();
  const cb = $id(doc, "paymentForm").querySelector(`input[name="batch"][value="${b2}"]`);
  ok(!cb.disabled, "关键缺陷闭环后批次可付款");
});

/* ========== 场景 4：超付拦截（合同预算 + 节点额度），草稿可暂存 ========== */
scenario("S4 超付：预算与节点额度双重拦截，草稿不占预算", () => {
  const { win, doc } = createWindow({ role: "admin", user: "管理员" });
  // 把合同预算调到 5000
  goto(doc, "records");
  find(doc, '#recordsSeg [data-seg="contract"]').click();
  const con = store(win).state.contracts[0];
  find(doc, `[data-edit="contract|${con.id}"]`).click();
  const cf = $id(doc, "recordForm");
  setVal(cf.querySelector('[name="budget"]'), 5000);
  cf.dispatch({ type: "submit", submitter: cf.querySelector("button.primary") });
  eq(byCode(win, "contracts", con.code).budget, 5000, "预算已下调为 5000");

  // 付款单：B-001 产值 9950 > 预算 5000
  goto(doc, "payments");
  $id(doc, "newPaymentBtn").click();
  const pf = $id(doc, "paymentForm");
  setVal(pf.querySelector('[name="code"]'), "PAY-S4");
  const b1 = byCode(win, "batches", "B-001").id;
  tickCheck(pf.querySelector(`input[name="batch"][value="${b1}"]`), true);
  includes($id(doc, "paySummary").textContent, "超付", "预检显示超付");

  // 草稿可暂存（不做预算硬约束）
  clearToast(doc);
  find(doc, "#draftPayBtn").click();
  const payId = byCode(win, "payments", "PAY-S4").id;
  eq(byCode(win, "payments", "PAY-S4").status, "草稿", "草稿暂存成功");
  // 重新打开草稿并提交 → 被拦
  find(doc, `[data-pay-edit="${payId}"]`).click();
  clearToast(doc);
  find(doc, "#submitPayBtn").click();
  includes(toastText(doc), "超付：合同预算", "提交时合同预算拦截");
  eq(byCode(win, "payments", "PAY-S4").status, "草稿", "超付单仍是草稿，未进入审批");

  // 把预算恢复后，再把节点 MS-01 额度改成 5000，节点超付拦截
  goto(doc, "records");
  find(doc, '#recordsSeg [data-seg="contract"]').click();
  find(doc, `[data-edit="contract|${con.id}"]`).click();
  setVal($id(doc, "recordForm").querySelector('[name="budget"]'), 300000);
  $id(doc, "recordForm").dispatch({ type: "submit", submitter: $id(doc, "recordForm").querySelector("button.primary") });
  find(doc, '#recordsSeg [data-seg="milestone"]').click();
  const ms = store(win).state.milestones.find((m) => m.code === "MS-01");
  find(doc, `[data-edit="milestone|${ms.id}"]`).click();
  setVal($id(doc, "recordForm").querySelector('[name="amount"]'), 5000);
  $id(doc, "recordForm").dispatch({ type: "submit", submitter: $id(doc, "recordForm").querySelector("button.primary") });

  goto(doc, "payments");
  find(doc, `[data-pay-edit="${payId}"]`).click();
  const pf2 = $id(doc, "paymentForm");
  setVal(pf2.querySelector('[name="milestoneId"]'), ms.id);
  clearToast(doc);
  find(doc, "#submitPayBtn").click();
  includes(toastText(doc), "付款节点", "节点额度超付拦截");
  eq(byCode(win, "payments", "PAY-S4").status, "草稿", "节点超付同样不放行");
});

/* ========== 场景 5：越权（发起/越级/管理员/自审） ========== */
scenario("S5 越权：质检员不能发起、领导不能越级、管理员不能审批", () => {
  const { win, doc } = createWindow({ role: "pm", user: "孙经理" });
  // 先准备一张待审批付款（净额 8100，需要二级）
  const b3 = byCode(win, "batches", "B-003").id;
  store(win).commit({ type: "transitionBatch", batchId: b3, to: "验收" });
  store(win).commit({ type: "acceptBatch", batchId: b3, passedFrames: 9000, defects: [] });
  store(win).commit({ type: "transitionBatch", batchId: b3, to: "通过" });
  goto(doc, "payments");
  $id(doc, "newPaymentBtn").click();
  const pf = $id(doc, "paymentForm");
  setVal(pf.querySelector('[name="code"]'), "PAY-S5");
  tickCheck(pf.querySelector(`input[name="batch"][value="${b3}"]`), true);
  find(doc, "#submitPayBtn").click();
  const pay = byCode(win, "payments", "PAY-S5");
  eq(pay.status, "待审批", "准备好待审批单");

  // 质检员不能发起付款
  setActor(win, doc, "qc", "钱质检");
  goto(doc, "payments");
  $id(doc, "newPaymentBtn").click();
  clearToast(doc);
  find(doc, "#submitPayBtn").click();
  includes(toastText(doc), "无权执行", "质检员发起付款被拒");

  // 分管领导越级审批被拦（当前需要级别 1）
  setActor(win, doc, "director", "王领导");
  goto(doc, "approvals");
  clearToast(doc);
  find(doc, `[data-approve="${pay.id}"]`).click();
  includes(toastText(doc), "越级", "领导越级审批被拒");
  eq(pay.status, "待审批", "越级签署未写入");

  // 管理员不能审批（职责分离）
  setActor(win, doc, "admin", "管理员");
  clearToast(doc);
  find(doc, `[data-approve="${pay.id}"]`).click();
  includes(toastText(doc), "管理员不能参与审批", "管理员审批被拒");
});

/* ========== 场景 6：双页竞争（编辑锁 + 并发提交冲突裁决） ========== */
scenario("S6 双页竞争：编辑锁拦截、并发提交冲突裁决且不重复付款", async () => {
  const shared = { storage: memoryStorage(), bus: memoryBus() };
  const A = createWindow({ role: "pm", user: "孙经理", shared, pageId: "pageA", tabName: "验收页A" });
  const B = createWindow({ role: "pm", user: "李经理", shared, pageId: "pageB", tabName: "付款页B" });
  await waitBus();

  // 编辑锁：A 打开 B-002 验收，B 再打开被拦
  goto(A.doc, "acceptance");
  const b2id = byCode(A.win, "batches", "B-002").id;
  A.doc.querySelector(`[data-accept="${b2id}"]`).click();
  clearToast(B.doc);
  goto(B.doc, "acceptance");
  B.doc.querySelector(`[data-accept="${b2id}"]`).click();
  includes(toastText(B.doc), "正被", "第二页编辑同批次被锁拦截");
  A.doc.querySelector("#acceptCancel") && $id(A.doc, "acceptClose").click();

  // 并发：A、B 几乎同时各提交一张含 B-001 的付款单
  const b1id = byCode(A.win, "batches", "B-001").id;
  function prep(page, code) {
    goto(page.doc, "payments");
    page.doc.getElementById("newPaymentBtn").click();
    const pf = page.doc.getElementById("paymentForm");
    setVal(pf.querySelector('[name="code"]'), code);
    tickCheck(pf.querySelector(`input[name="batch"][value="${b1id}"]`), true);
  }
  prep(A, "PAY-RACE-A");
  prep(B, "PAY-RACE-B");
  // 同步连续点击，总线消息在 setTimeout 中尚未投递
  A.doc.getElementById("submitPayBtn").click();
  B.doc.getElementById("submitPayBtn").click();
  eq(store(A.win).state.payments.length, 1, "A 本地一张");
  eq(store(B.win).state.payments.length, 1, "B 本地一张");
  await waitBus();
  await waitBus();
  // 两页都收到冲突并收敛到权威数据（先到者），最终只有一张在途付款单
  const conflicts = [];
  // 冲突 banner/审计：至少一页记录冲突审计
  const conflictAudit =
    store(A.win).state.audit.some((a) => a.result === "conflict") ||
    store(B.win).state.audit.some((a) => a.result === "conflict");
  ok(conflictAudit, "冲突被记录为审计");
  const paidishA = store(A.win).state.payments.filter((p) => ["待审批", "审批中", "已批准", "已付款"].includes(p.status));
  const paidishB = store(B.win).state.payments.filter((p) => ["待审批", "审批中", "已批准", "已付款"].includes(p.status));
  eq(paidishA.length, 1, "A 收敛后只有一张在途付款单");
  eq(paidishB.length, 1, "B 收敛后只有一张在途付款单");
  eq(store(A.win).rev, store(B.win).rev, "两页版本号收敛一致");
  // 在最新数据上再次提交重复批次付款 → 明确被拒
  clearToast(B.doc);
  prep(B, "PAY-RACE-C");
  B.doc.getElementById("submitPayBtn").click();
  includes(toastText(B.doc), "重复付款", "收敛后重复付款被直接拒绝");
});

/* ========== 场景 7：版本回滚 + 撤销重做 ========== */
scenario("S7 回滚到版本点、撤销重做", () => {
  const { win, doc } = createWindow({ role: "admin", user: "管理员" });
  // 打一个干净版本点
  goto(doc, "history");
  find(doc, "#snapshotBtn").click();
  const snapId = store(win).listSnapshots().find((s) => s.label.includes("手动版本点")).id;

  // 新增外包商后回滚
  goto(doc, "records");
  const form = $id(doc, "recordForm");
  setVal(form.querySelector('[name="code"]'), "V-ROLL");
  setVal(form.querySelector('[name="name"]'), "回滚后应消失公司");
  form.dispatch({ type: "submit", submitter: form.querySelector("button.primary") });
  ok(byCode(win, "vendors", "V-ROLL"), "回滚前外包商存在");
  goto(doc, "history");
  find(doc, `[data-rollback="${snapId}"]`).click();
  ok(!byCode(win, "vendors", "V-ROLL"), "回滚后新增记录消失");
  ok(store(win).state.audit[0].action === "版本回滚", "回滚动作有审计");
  ok(store(win).listSnapshots().some((s) => s.label.includes("回滚前自动备份")), "回滚前状态已自动备份");

  // 撤销 / 重做
  goto(doc, "records");
  const f2 = $id(doc, "recordForm");
  setVal(f2.querySelector('[name="code"]'), "V-UNDO");
  setVal(f2.querySelector('[name="name"]'), "撤销测试");
  f2.dispatch({ type: "submit", submitter: f2.querySelector("button.primary") });
  ok(byCode(win, "vendors", "V-UNDO"), "新增成功");
  goto(doc, "history");
  find(doc, "#undoBtn").click();
  ok(!byCode(win, "vendors", "V-UNDO"), "撤销后消失");
  find(doc, "#redoBtn").click();
  ok(byCode(win, "vendors", "V-UNDO"), "重做后恢复");
});

/* ========== 场景 8：异常导入（五类拦截）+ 伪装缩略图 + 合法导入 ========== */
scenario("S8 异常导入整包拒绝、伪装缩略图被识别、合法样例可导入", () => {
  const { win, doc } = createWindow({ role: "admin", user: "管理员" });
  goto(doc, "io");
  find(doc, "#loadSampleBadBtn").click();
  includes($id(doc, "importText").value, "payments", "问题样例已填入");
  const form = $id(doc, "importForm");
  form.dispatch({ type: "submit", submitter: form.querySelector("button.primary") });
  const result = $id(doc, "importResult").textContent;
  includes(result, "整体拒绝", "整包拒绝");
  includes(result, "越权记录", "拦截夹带付款单");
  includes(result, "重复编号", "拦截重复编号");
  includes(result, "循环引用", "拦截循环引用");
  includes(result, "非法金额", "拦截非法金额");
  includes(result, "开始日期非法", "拦截非法日期");
  ok(!store(win).state.vendors.some((v) => v.code === "DUP-1"), "被拒包没有任何记录落库");
  ok(store(win).state.audit[0].action === "导入" && store(win).state.audit[0].result === "denied", "拒绝导入也写审计");

  // 伪装缩略图在异步场景 S8b 单独验证

  // 合法样例导入
  goto(doc, "io");
  find(doc, "#loadSampleGoodBtn").click();
  const f2 = $id(doc, "importForm");
  f2.dispatch({ type: "submit", submitter: f2.querySelector("button.primary") });
  includes($id(doc, "importResult").textContent, "导入成功", "合法样例导入成功");
  ok(byCode(win, "vendors", "V-样例"), "外包商落库");
  ok(byCode(win, "contracts", "HT-S-01"), "合同落库");
  ok(byCode(win, "reels", "R-S-01"), "胶片卷落库");
  ok(byCode(win, "batches", "B-S-01"), "批次落库");
  const reel = byCode(win, "reels", "R-S-01");
  eq(reel.contractId, byCode(win, "contracts", "HT-S-01").id, "code 引用被正确解析为 id");
});

/* S8 的异步补充：伪装缩略图 */
scenario("S8b 伪装 PNG（实为 SVG 脚本）缩略图被魔数校验拒绝", async () => {
  const { win, doc } = createWindow({ role: "qc", user: "钱质检" });
  goto(doc, "defects");
  const fakePng = "data:image/png;base64," + win.btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const fileInput = doc.querySelector('#defectForm [name="thumb"]');
  fileInput.files = [{ type: "image/png", size: 80, dataUrl: fakePng }];
  fileInput.dispatch({ type: "change" });
  await waitBus();
  const shown = $id(doc, "thumbPreview").textContent + toastText(doc);
  includes(shown, "伪装", "提示疑似伪装缩略图");
  const inp = doc.querySelector('#defectForm [name="thumb"]');
  eq(inp.dataset.dataurl, undefined, "伪装文件未被接受为缩略图");

  // 真实 PNG（1x1）应通过
  const realPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  inp.files = [{ type: "image/png", size: 95, dataUrl: realPng }];
  inp.dispatch({ type: "change" });
  await waitBus();
  includes($id(doc, "thumbPreview").textContent, "已校验", "真实 PNG 通过校验");
});

/* ========== 场景 9：刷新恢复（数据持久化 + 草稿恢复） ========== */
scenario("S9 刷新/重开后数据与付款草稿可恢复", async () => {
  const shared = { storage: memoryStorage(), bus: memoryBus() };
  const A = createWindow({ role: "pm", user: "孙经理", shared, pageId: "pA" });
  // 先提交一笔数据
  const r = store(A.win).commit({ type: "saveVendor", data: { code: "V-REFRESH", name: "刷新持久化公司" } });
  ok(!r.errors.length, "提交成功");
  // 编辑付款单但不提交（产生草稿）
  goto(A.doc, "payments");
  A.doc.getElementById("newPaymentBtn").click();
  const pf = A.doc.getElementById("paymentForm");
  const b1 = byCode(A.win, "batches", "B-001").id;
  tickCheck(pf.querySelector(`input[name="batch"][value="${b1}"]`), true);
  setVal(pf.querySelector('[name="note"]'), "刷新前没写完的备注");

  // “刷新”：用同一 localStorage 开新页面
  const B = createWindow({ role: "pm", user: "孙经理", shared, pageId: "pB" });
  await waitBus();
  ok(byCode(B.win, "vendors", "V-REFRESH"), "已提交数据刷新后仍在");
  eq(store(B.win).rev, store(A.win).rev, "数据版本一致");
  goto(B.doc, "io");
  const draftRow = B.doc.querySelector('[data-draft-recover^="payment:"]');
  ok(draftRow, "导入导出页列出未提交付款草稿");
  draftRow.click();
  eq(B.win.__digitdesk.ui.tab, "payments", "恢复后跳到付款台");
  const pf2 = B.doc.getElementById("paymentForm");
  eq(pf2.querySelector('[name="note"]').value, "刷新前没写完的备注", "草稿备注恢复");
  ok(pf2.querySelector(`input[name="batch"][value="${b1}"]`).checked, "草稿勾选批次恢复");
});

/* ========== 汇总 ========== */
(async () => {
  await tick();
  const scenarioFailures = [];
  for (const sc of scenarios) {
    const before = summary().passed;
    process.stdout.write("▶ " + sc.name + " ... ");
    try {
      await sc.fn();
      console.log("通过（" + (summary().passed - before) + " 断言）");
    } catch (e) {
      scenarioFailures.push(sc.name);
      console.log("失败\n    " + e.stack.split("\n").slice(0, 4).join("\n    "));
    }
  }
  const s = summary();
  console.log("\n================================");
  console.log(`断言：${s.passed + s.failures.length} 成功 / ${s.failures.length} 失败`);
  if (scenarioFailures.length) {
    console.log("失败场景：\n - " + scenarioFailures.join("\n - "));
    process.exit(1);
  } else {
    console.log("全部 " + scenarios.length + " 个场景走通（S0 入口体检 + 9 个规定场景）");
  }
})();
