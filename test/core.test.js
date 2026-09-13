/*
 * core.test.js —— 业务规则核心的纯单元测试（不依赖 DOM）
 * 运行：node test/core.test.js
 */
"use strict";
const C = require("../js/core.js");

let pass = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) pass++;
  else { fails.push(msg); throw new Error(msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`); }
function expectDenied(res, fragment, msg) {
  ok(res.errors.length > 0, msg + "（应被拒绝）");
  ok(res.errors[0].message.includes(fragment), `${msg}：原因包含「${fragment}」，实际：${res.errors[0].message}`);
}
function run(name, fn) {
  try { fn(); console.log("✓ " + name); }
  catch (e) { console.log("✗ " + name + "\n  " + e.message); fails.push(name); }
}

/* 工具函数 */
run("金额/日期/比例解析严格", () => {
  ok(Number.isNaN(C.num("壹万")), "中文金额拒绝");
  ok(Number.isNaN(C.num("12abc")), "尾随字符拒绝");
  eq(C.num("1,234.5"), 1234.5, "千分位");
  ok(C.isValidDate("2026-02-29") === false, "2026-02-29 不存在");
  ok(C.isValidDate("2024-02-29") === true, "2024 闰年合法");
  ok(C.isValidDate("2026-13-01") === false, "月份越界");
});

run("循环检测", () => {
  const edges = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]);
  ok(C.findAnyCycle(edges), "三环成环");
  const edges2 = new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]);
  ok(!C.findAnyCycle(edges2), "链条无环");
});

/* 状态机 */
run("批次状态机非法流转拒绝", () => {
  let s = C.seedState();
  const b1 = s.batches[0]; // 已通过
  const r = C.dispatch(s, { type: "transitionBatch", batchId: b1.id, to: "验收" }, { role: "qc", userName: "q" });
  expectDenied(r, "不能从", "通过→验收非法");
});

run("冻结/解冻仅项目经理和管理员", () => {
  let s = C.seedState();
  const b3 = s.batches[2];
  const r1 = C.dispatch(s, { type: "transitionBatch", batchId: b3.id, to: "冻结" }, { role: "qc", userName: "q" });
  expectDenied(r1, "只有项目经理/管理员", "质检员不能冻结");
  const r2 = C.dispatch(s, { type: "transitionBatch", batchId: b3.id, to: "冻结" }, { role: "pm", userName: "p" });
  ok(!r2.errors.length, "项目经理可以冻结");
  s = r2.state;
  const frozen = s.batches.find((b) => b.id === b3.id);
  eq(frozen.status, "冻结", "已冻结");
  const r3 = C.dispatch(s, { type: "transitionBatch", batchId: b3.id, to: "待扫描" }, { role: "pm", userName: "p" });
  ok(!r3.errors.length, "项目经理可以解冻");
});

/* 关键缺陷 */
run("关键缺陷未闭环禁止判通过与付款", () => {
  let s = C.seedState();
  const b2 = s.batches[1]; // 验收中、带未闭环关键缺陷 D-002
  const r1 = C.dispatch(s, { type: "transitionBatch", batchId: b2.id, to: "通过" }, { role: "qc", userName: "q" });
  expectDenied(r1, "未闭环关键缺陷", "判通过拦截");
  // 即使强行构造通过批次，付款也要拦
  s = C.dispatch(s, { type: "transitionDefect", defectId: s.defects.find((d) => d.code === "D-002").id, to: "已返工待复验" }, { role: "qc", userName: "q" }).state;
  // 关键缺陷仍未闭环（已返工待复验），依然拦截
  const stillCrit = C.openCriticalDefectIds(s, b2.id).length;
  ok(stillCrit === 1, "已返工待复验的关键缺陷仍阻塞");
});

/* 付款规则 */
function paidFixture() {
  let s = C.seedState();
  // B-003 走完
  const b3 = s.batches[2];
  const pm = { role: "pm", userName: "孙经理" };
  s = C.dispatch(s, { type: "transitionBatch", batchId: b3.id, to: "验收" }, pm).state;
  s = C.dispatch(s, { type: "acceptBatch", batchId: b3.id, passedFrames: 9000, defects: [] }, pm).state;
  s = C.dispatch(s, { type: "transitionBatch", batchId: b3.id, to: "通过" }, pm).state;
  return { s, b3, pm };
}

run("金额计算：产值-扣款-保证金=应付", () => {
  const { s, b3 } = paidFixture();
  const p = { id: "x", contractId: s.contracts[0].id, batchIds: [b3.id], deductions: [{ reason: "延迟", amount: 500 }] };
  const a = C.computePaymentAmounts(s, p);
  eq(a.gross, 9000, "产值 9000");
  eq(a.deductions, 500, "扣款 500");
  eq(a.retention, 850, "保证金 10% × 8500");
  eq(a.net, 7650, "应付 7650");
});

run("重复付款：同批次不能重复进入在途/已付单", () => {
  let { s, b3, pm } = paidFixture();
  const mk = (code) => ({ type: "savePayment", data: { code, contractId: s.contracts[0].id, milestoneId: "", batchIds: [b3.id], deductions: [] }, submit: true });
  const r1 = C.dispatch(s, mk("PAY-A"), pm);
  ok(!r1.errors.length, "第一张提交成功");
  s = r1.state;
  const r2 = C.dispatch(s, mk("PAY-B"), pm);
  expectDenied(r2, "重复付款", "第二张重复批次被拦");
});

run("合同预算超付拦截", () => {
  let { s, b3, pm } = paidFixture();
  s.contracts[0].budget = 5000;
  const r = C.dispatch(s, { type: "savePayment", data: { code: "PAY-X", contractId: s.contracts[0].id, milestoneId: "", batchIds: [b3.id], deductions: [] }, submit: true }, pm);
  expectDenied(r, "超付：合同预算", "预算超付");
  // 草稿允许
  const rd = C.dispatch(s, { type: "savePayment", data: { code: "PAY-D", contractId: s.contracts[0].id, milestoneId: "", batchIds: [b3.id], deductions: [] }, submit: false }, pm);
  ok(!rd.errors.length, "草稿不做预算占用");
});

run("验收比例不足拦截付款", () => {
  let { s, b3, pm } = paidFixture();
  s.contracts[0].minPassRatio = 0.99;
  // 总扫描 21000（10000+2000+9000），合格 9950+9000=18950，比例 0.902
  const r = C.dispatch(s, { type: "savePayment", data: { code: "PAY-R", contractId: s.contracts[0].id, milestoneId: "", batchIds: [b3.id], deductions: [] }, submit: true }, pm);
  expectDenied(r, "验收比例不足", "最低验收比例");
});

run("多级审批：顺序、越级、重复、自审、职责分离", () => {
  let { s, b3 } = paidFixture();
  const submitter = { role: "pm", userName: "孙经理" };
  const r0 = C.dispatch(s, { type: "savePayment", data: { code: "PAY-L3", contractId: s.contracts[0].id, milestoneId: "", batchIds: [b3.id], deductions: [] }, submit: true }, submitter);
  s = r0.state;
  const p = s.payments[0];
  eq(p.requiredLevel, 2, "8100 需 2 级");
  // 自审
  expectDenied(C.dispatch(s, { type: "approvePayment", paymentId: p.id }, submitter), "提交人不能审批自己", "自审拦截");
  // 财务先签（越级）
  expectDenied(C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "finance", userName: "吴财务" }), "审批顺序错误", "越级拦截");
  // 管理员不参与审批
  expectDenied(C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "admin", userName: "管理员" }), "管理员不能参与审批", "管理员审批拦截");
  // pm1 签
  s = C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "pm", userName: "李经理" }).state;
  eq(s.payments[0].status, "审批中", "一级后审批中");
  // 同级别再签（当前需要的是 2 级）→ 顺序/越级错误，1 级签署不会被重复计入
  expectDenied(C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "pm", userName: "赵经理" }), "审批顺序错误", "同一级别不能重复审批");
  // finance 终审
  s = C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "finance", userName: "吴财务" }).state;
  eq(s.payments[0].status, "已批准", "二级后已批准");
  // 未批准不能付款；已批准时只有财务能付
  const rAdmin = C.dispatch(s, { type: "payPayment", paymentId: p.id }, { role: "admin", userName: "管理员" });
  expectDenied(rAdmin, "管理员不能直接确认付款", "管理员不能付款");
  s = C.dispatch(s, { type: "payPayment", paymentId: p.id }, { role: "finance", userName: "吴财务" }).state;
  eq(s.payments[0].status, "已付款", "财务付款成功");
  // 再付一次
  expectDenied(C.dispatch(s, { type: "payPayment", paymentId: p.id }, { role: "finance", userName: "吴财务" }), "不能付款", "二次付款拦截");
});

run("大额付款需三级（分管领导）", () => {
  let { s, b3, pm } = paidFixture();
  // 把合格画幅做大：让 B-001 与 B-003 同时通过
  // B-001 已通过（9950），与 B-003 合并 18950 产值，净额约 17055 > 100000? 不够。
  // 直接用单价调整触发三级
  s.contracts[0].unitPrice = 20;
  const r = C.dispatch(s, { type: "savePayment", data: { code: "PAY-BIG", contractId: s.contracts[0].id, milestoneId: "", batchIds: [b3.id], deductions: [] }, submit: true }, pm);
  ok(!r.errors.length, "大额单提交：" + r.errors.map((e) => e.message).join("；"));
  s = r.state;
  const p = s.payments.find((x) => x.code === "PAY-BIG");
  eq(p.requiredLevel, 3, "162000 净额需 3 级");
  s = C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "pm", userName: "李经理" }).state;
  s = C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "finance", userName: "吴财务" }).state;
  eq(s.payments.find((x) => x.code === "PAY-BIG").status, "审批中", "两级后仍在审批中");
  s = C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "director", userName: "王领导" }).state;
  eq(s.payments.find((x) => x.code === "PAY-BIG").status, "已批准", "领导签完批准");
});

run("质检员无权发起付款；项目经理超额发起拦截", () => {
  let { s, b3 } = paidFixture();
  const r1 = C.dispatch(s, { type: "savePayment", data: { code: "PAY-Q", contractId: s.contracts[0].id, batchIds: [b3.id], deductions: [] }, submit: true }, { role: "qc", userName: "钱质检" });
  expectDenied(r1, "无权执行", "质检员发起拒绝");
  // 直接用超出 PM 发起额度（50 万）的申报净额触发越权
  const r2 = C.dispatch(s, { type: "savePayment", data: { code: "PAY-CAP", contractId: s.contracts[0].id, batchIds: [b3.id], deductions: [], tentativeNet: 600000 }, submit: true }, { role: "pm", userName: "孙经理" });
  expectDenied(r2, "越权", "项目经理超额度发起拒绝");
});

run("付款节点：前置未付款与节点额度", () => {
  let { s, b3, pm } = paidFixture();
  const ms2 = s.milestones.find((m) => m.code === "MS-02");
  // 绑定 MS-02：前置 MS-01 未付款
  const r1 = C.dispatch(s, { type: "savePayment", data: { code: "PAY-MS", contractId: s.contracts[0].id, milestoneId: ms2.id, batchIds: [b3.id], deductions: [] }, submit: true }, pm);
  expectDenied(r1, "前置付款节点", "前置节点未付款拦截");
  // 节点额度
  const ms1 = s.milestones.find((m) => m.code === "MS-01");
  ms1.amount = 5000;
  const r2 = C.dispatch(s, { type: "savePayment", data: { code: "PAY-MS2", contractId: s.contracts[0].id, milestoneId: ms1.id, batchIds: [b3.id], deductions: [] }, submit: true }, pm);
  expectDenied(r2, "付款节点", "节点额度超付拦截");
});

run("付款前终检：批准后关键缺陷重开则不能付款", () => {
  let { s, b3 } = paidFixture();
  const pm = { role: "pm", userName: "孙经理" };
  s = C.dispatch(s, { type: "savePayment", data: { code: "PAY-F", contractId: s.contracts[0].id, batchIds: [b3.id], deductions: [] }, submit: true }, pm).state;
  const p = s.payments[0];
  s = C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "pm", userName: "李经理" }).state;
  s = C.dispatch(s, { type: "approvePayment", paymentId: p.id }, { role: "finance", userName: "吴财务" }).state;
  eq(s.payments[0].status, "已批准", "已批准");
  // 批准后给该批次补一个未闭环关键缺陷
  s = C.dispatch(s, { type: "saveDefect", data: { code: "D-LATE", batchId: b3.id, severity: "关键", type: "事后发现", description: "付款前抽查发现严重问题", status: "待整改" } }, { role: "qc", userName: "钱质检" }).state;
  const r = C.dispatch(s, { type: "payPayment", paymentId: p.id }, { role: "finance", userName: "吴财务" });
  expectDenied(r, "终检失败", "付款前终检拦截");
  eq(r.state.payments[0].status, "已批准", "状态未变");
});

/* 导入校验 */
run("导入：五类异常 + 越权记录全部识别", () => {
  const errs = C.validateImport(C.emptyState(), {
    payments: [{ code: "X" }],
    vendors: [{ code: "DUP", name: "甲" }, { code: "DUP", name: "乙" }],
    contracts: [{ code: "C", budget: "bad", unitPrice: 1, startDate: "2026-13-01", endDate: "2026-02-29" }],
    reels: [
      { code: "R1", contractCode: "C", totalFrames: 1, prevReelCode: "R3" },
      { code: "R2", contractCode: "C", totalFrames: 1, prevReelCode: "R1" },
      { code: "R3", contractCode: "C", totalFrames: 1, prevReelCode: "R2" }
    ]
  });
  const blob = errs.join("\n");
  ok(blob.includes("越权记录"), "越权记录");
  ok(blob.includes("重复编号"), "重复编号");
  ok(blob.includes("循环引用"), "循环引用");
  ok(blob.includes("非法") || blob.includes("必须是数字"), "非法金额/日期");
});

run("导入：合法包可合并且 code 引用被解析（支持后置引用）", () => {
  let s = C.emptyState();
  // 顺序故意打乱：reel 引用的 contract 在其后
  const payload = {
    reels: [{ code: "R1", name: "卷", contractCode: "C1", totalFrames: 100, prevReelCode: "R0" }],
    vendors: [{ code: "V1", name: "商" }],
    contracts: [{ code: "C1", vendorCode: "V1", budget: 1000, unitPrice: 2, retentionRate: 0, startDate: "2026-01-01", endDate: "2026-12-31" }],
    batches: [{ code: "B1", reelCode: "R1", frames: 50 }],
    defects: [{ code: "D1", batchCode: "B1", severity: "一般" }],
    milestones: [{ code: "M0", contractCode: "C1", amount: 100, prereqCodes: [] }, { code: "M1", contractCode: "C1", amount: 100, prereqCodes: ["M0"] }]
  };
  // 先放一个 R0 卷供 prev 引用
  s = C.dispatch(s, { type: "importBundle", payload: { vendors: payload.vendors, contracts: payload.contracts, reels: [{ code: "R0", contractCode: "C1", totalFrames: 10 }] } }, { role: "admin", userName: "a" }).state;
  const r = C.dispatch(s, { type: "importBundle", payload }, { role: "admin", userName: "a" });
  ok(!r.errors.length, "合并成功：" + r.errors.map((e) => e.message).join("；"));
  s = r.state;
  eq(s.reels.length, 2, "两卷");
  const r1 = s.reels.find((x) => x.code === "R1");
  eq(r1.contractId, s.contracts.find((x) => x.code === "C1").id, "合同引用解析");
  eq(r1.prevReelId, s.reels.find((x) => x.code === "R0").id, "后置/库内卷引用解析");
  eq(s.batches[0].reelId, r1.id, "批次引用解析");
  eq(s.defects[0].batchId, s.batches[0].id, "缺陷引用解析");
});

/* 缩略图魔数 */
run("伪装缩略图：SVG 脚本即便声称 PNG 也被拒", () => {
  const svg = "data:image/png;base64," + Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64");
  let threw = false;
  try { C.validateThumbData(svg, ""); } catch (e) { threw = true; }
  ok(threw, "伪装 PNG 被拒");
  let threw2 = false;
  try { C.validateThumbData("data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"), ""); } catch (e) { threw2 = true; }
  ok(threw2, "SVG MIME 直接拒绝");
  const realPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  eq(C.validateThumbData(realPng, ""), realPng, "真实 PNG 通过");
});

/* 删除保护 */
run("删除：被引用记录不能删，草稿/驳回付款单可删", () => {
  let s = C.seedState();
  const con = s.contracts[0];
  const r1 = C.dispatch(s, { type: "deleteEntity", kind: "contract", id: con.id }, { role: "admin", userName: "a" });
  expectDenied(r1, "被", "合同被胶片卷引用不能删");
  const pm = { role: "pm", userName: "孙经理" };
  const { s: s2, b3 } = paidFixture();
  let st = s2;
  st = C.dispatch(st, { type: "savePayment", data: { code: "PAY-D", contractId: st.contracts[0].id, batchIds: [b3.id], deductions: [] }, submit: false }, pm).state;
  const draftId = st.payments[0].id;
  const rd = C.dispatch(st, { type: "deleteEntity", kind: "payment", id: draftId }, { role: "admin", userName: "a" });
  ok(!rd.errors.length, "草稿付款单可删");
});

/* 原子性：拒绝动作不改业务数据 */
run("原子性：被拒动作不留半成品/重复 ID", () => {
  const s = C.seedState();
  const before = { v: s.vendors.length, c: s.contracts.length, r: s.reels.length };
  C.dispatch(s, { type: "saveVendor", data: { code: "V-华影", name: "重复商" } }, { role: "admin", userName: "a" });
  C.dispatch(s, { type: "saveContract", data: { code: "X", budget: -5, unitPrice: 1, retentionRate: 0, startDate: "2026-01-01", endDate: "2026-12-31" } }, { role: "admin", userName: "a" });
  eq(s.vendors.length, before.v, "外包商数量不变（原状态未被改）");
  eq(s.contracts.length, before.c, "合同数量不变");
});

/* 汇总 */
console.log("\n================");
console.log(`通过 ${pass} 个断言，失败 ${fails.length}`);
if (fails.length) process.exit(1);
console.log("core 单元测试全部通过");
