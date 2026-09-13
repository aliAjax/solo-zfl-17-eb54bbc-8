/*
 * browser-e2e.js —— 用真实 Chrome（Playwright 驱动）做双时区端到端验证。
 * 用法：TZ=<时区> node test/browser-e2e.js [baseURL]
 * 覆盖：启动/八工作台、合法日期、非法日期（闰年/月末/越界）、导入拦截、
 *       正常验收→多级审批→付款、刷新后数据与草稿恢复。
 */
"use strict";
const { chromium } = require("playwright");

const TZ = process.env.TZ || "UTC";
const BASE = process.argv[2] || "http://127.0.0.1:8923";
const CHROME = process.env.CHROME_PATH || "/tmp/chromium-arm64/chrome-linux/chrome";

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? " —— " + extra : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("dialog", (d) => d.accept(""));

  console.log(`\n[${TZ}] 真实 Chrome ${await browser.version()}，打开 ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(200);

  /* ---- 0. 浏览器时区确认 ---- */
  const off = await page.evaluate(() => new Date().getTimezoneOffset());
  const tzName = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log(`  浏览器时区：${tzName}，UTC 偏移 ${off} 分钟`);

  /* ---- 1. 启动：八工作台初始化（原 bug：中文时区抛错打不开）---- */
  check("页面成功加载、标题正确", (await page.title()).includes("离线数字化验收与付款台"));
  const statCards = await page.locator(".stat-card").count();
  check("概览统计卡渲染 6 张", statCards === 6, "实际 " + statCards);
  const pipeCols = await page.locator(".pipe-col").count();
  check("批次五状态流水线渲染", pipeCols === 5, "实际 " + pipeCols);
  check("启动无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  const tabs = ["dashboard", "records", "acceptance", "defects", "payments", "approvals", "history", "io"];
  for (const t of tabs) {
    await page.click(`#tabs [data-tab="${t}"]`);
    await sleep(60);
    const visibleText = await page.locator(`.view[data-view="${t}"]`).innerText();
    check(`工作台「${t}」有实质内容`, visibleText.replace(/\s+/g, "").length > 40);
  }

  /* ---- 2. 时区无关日期：种子合同合法存在；核心函数在浏览器内判定一致 ---- */
  const seedContract = await page.evaluate(() => {
    const c = window.__digitdesk.store.state.contracts.find((x) => x.code === "HT-2026-01");
    return c ? { code: c.code, start: c.startDate, end: c.endDate } : null;
  });
  check("种子合同在本时区下成功创建（startDate 不被错判）", !!seedContract && seedContract.start === "2026-01-01", JSON.stringify(seedContract));

  const dateMatrix = await page.evaluate(() => {
    const C = window.Core;
    const cases = {
      "2026-01-01": true,
      "2024-02-29": true,   // 闰年
      "2000-02-29": true,   // 世纪闰年
      "2026-02-28": true,
      "2026-03-31": true,
      "2026-12-31": true,
      "2026-02-29": false,  // 平年闰日
      "1900-02-29": false,  // 平世纪
      "2026-04-31": false,  // 4 月只有 30 天
      "2026-13-01": false,  // 月份越界
      "2026-00-10": false,
      "2026-2-9": false,    // 非零填充
      "abc": false,
      "": false
    };
    const out = {};
    for (const [k, want] of Object.entries(cases)) {
      const got = C.isValidDate(k);
      out[k] = { want, got, pass: got === want };
    }
    return out;
  });
  const dateFails = Object.entries(dateMatrix).filter(([, v]) => !v.pass);
  check("闰年/月末/非法日期全部区分正确（14 例）", dateFails.length === 0, JSON.stringify(dateFails));

  /* ---- 3. 非法日期在应用核心被拒、合法月末可保存 ---- */
  await page.click('#tabs [data-tab="records"]');
  await page.click('#recordsSeg [data-seg="contract"]');
  const contractId = await page.evaluate(() => window.__digitdesk.store.state.contracts[0].id);

  // 非法日期即使绕过日期控件（如直接构造提交/导入）也必须被核心拒绝，且数据不变
  const illegalAttempt = await page.evaluate((cid) => {
    const { store } = window.__digitdesk;
    const c = store.state.contracts.find((x) => x.id === cid);
    const before = c.endDate;
    const tryDate = (endDate) =>
      store.commit({
        type: "saveContract",
        data: { id: cid, code: c.code, name: c.name, vendorId: c.vendorId, budget: c.budget, unitPrice: c.unitPrice, retentionRate: c.retentionRate, minPassRatio: c.minPassRatio, startDate: c.startDate, endDate }
      }).errors.map((e) => e.message);
    const e1 = tryDate("2026-02-29"); // 平年闰日
    const e2 = tryDate("2026-13-40"); // 越界
    const e3 = tryDate("2026/12/31"); // 错误格式
    const after = store.state.contracts.find((x) => x.id === cid).endDate;
    return { e1: e1[0] || "", e2: e2[0] || "", e3: e3[0] || "", before, after, unchanged: before === after };
  }, contractId);
  check("核心拒绝 2026-02-29（平年）", illegalAttempt.e1.includes("结束日期非法"), illegalAttempt.e1);
  check("核心拒绝 2026-13-40（越界）", illegalAttempt.e2.includes("结束日期非法"), illegalAttempt.e2);
  check("核心拒绝 2026/12/31（非 YYYY-MM-DD）", illegalAttempt.e3.includes("结束日期非法"), illegalAttempt.e3);
  check("被拒后合同结束日期不变（原子性）", illegalAttempt.unchanged, `${illegalAttempt.before} -> ${illegalAttempt.after}`);

  // 合法月末日期通过真实日期控件保存
  await page.click(`[data-edit="contract|${contractId}"]`);
  await page.fill('#recordForm [name="endDate"]', "2026-11-30");
  await page.click('#recordForm button.primary');
  await sleep(150);
  const savedOk = await page.evaluate(() => window.__digitdesk.store.state.contracts[0].endDate === "2026-11-30");
  check("合法月末日期 2026-11-30 可保存", savedOk);
  await page.click(`[data-edit="contract|${contractId}"]`);
  await page.fill('#recordForm [name="endDate"]', "2026-12-31");
  await page.click('#recordForm button.primary');
  await sleep(100);

  /* ---- 4. 导入：问题样例整包拒绝（含非法日期/循环/越权/伪装缩略图）---- */
  await page.click('#tabs [data-tab="io"]');
  await page.click("#loadSampleBadBtn");
  await page.click('#importForm button.primary');
  await sleep(150);
  const badImport = await page.locator("#importResult").innerText();
  check("问题样例整体拒绝", badImport.includes("整体拒绝"));
  for (const frag of ["越权记录", "重复编号", "循环引用", "必须是数字", "日期非法", "伪装"]) {
    check(`问题样例命中拦截：${frag}`, badImport.replace(/\s+/g, "").includes(frag.replace(/\s+/g, "")), "未出现 " + frag);
  }
  const noWrite = await page.evaluate(() => !window.__digitdesk.store.state.vendors.some((v) => v.code === "DUP-1"));
  check("被拒导入零记录落库", noWrite);

  // 合法样例导入成功（含 2026 闰年外的正常日期 2026-07-01）
  await page.click("#loadSampleGoodBtn");
  await page.click('#importForm button.primary');
  await sleep(150);
  const goodImport = await page.locator("#importResult").innerText();
  check("合法样例导入成功", goodImport.includes("导入成功"), goodImport.slice(0, 100));
  const importedReel = await page.evaluate(() => {
    const s = window.__digitdesk.store.state;
    const r = s.reels.find((x) => x.code === "R-S-01");
    return r && r.contractId === s.contracts.find((c) => c.code === "HT-S-01").id;
  });
  check("导入的 code 引用被正确解析", !!importedReel);

  /* ---- 5. 正常验收 → 多级审批 → 付款（真实点击）---- */
  const actor = async (role, name) => {
    await page.selectOption("#roleSelect", role);
    await page.fill("#userNameInput", name);
    await page.dispatchEvent("#userNameInput", "change");
    await sleep(50);
  };

  await page.click('#tabs [data-tab="acceptance"]');
  const b3 = await page.evaluate(() => window.__digitdesk.store.state.batches.find((b) => b.code === "B-003").id);
  await page.click(`[data-trans="${b3}|验收"]`);
  await sleep(120);
  await page.click(`[data-accept="${b3}"]`);
  await page.fill('#acceptForm [name="passedFrames"]', "9000");
  await page.dispatchEvent('#acceptForm [name="passedFrames"]', "input");
  await page.click('#acceptForm button[value="pass"]');
  await sleep(150);
  const passed = await page.evaluate(() => {
    const b = window.__digitdesk.store.state.batches.find((x) => x.code === "B-003");
    return b.status === "通过" && b.passedFrames === 9000;
  });
  check("B-003 验收 9000 并判通过", passed);

  await actor("pm", "孙经理");
  await page.click('#tabs [data-tab="payments"]');
  await page.click("#newPaymentBtn");
  await page.fill('#paymentForm [name="code"]', "PAY-E2E");
  await page.dispatchEvent('#paymentForm [name="code"]', "input");
  await page.check(`#paymentForm input[name="batch"][value="${b3}"]`);
  await sleep(100);
  const summary = await page.locator("#paySummary").innerText();
  check("付款预检金额正确（9000 产值 / 900 保证金 / 8100 应付）", summary.includes("8,100.00") && summary.includes("硬约束通过"), summary.replace(/\s+/g, " ").slice(0, 120));
  await page.click("#submitPayBtn");
  await sleep(150);
  const submitted = await page.evaluate(() => {
    const p = window.__digitdesk.store.state.payments.find((x) => x.code === "PAY-E2E");
    return p && p.status === "待审批" && p.requiredLevel === 2;
  });
  check("付款单提交，需二级审批", submitted);

  // 自审拦截
  const payId = await page.evaluate(() => window.__digitdesk.store.state.payments.find((x) => x.code === "PAY-E2E").id);
  await page.click('#tabs [data-tab="approvals"]');
  await page.click(`[data-approve="${payId}"]`);
  await sleep(120);
  const afterSelf = await page.evaluate(() => window.__digitdesk.store.state.payments.find((x) => x.code === "PAY-E2E").status);
  const selfToast = await page.locator("#toastHost").innerText();
  check("提交人自审被拦截", selfToast.includes("提交人不能审批自己") && afterSelf === "待审批", afterSelf);

  // 另一 PM 签一级
  await actor("pm", "李经理");
  await page.click(`[data-approve="${payId}"]`);
  await sleep(120);
  const lvl1 = await page.evaluate(() => window.__digitdesk.store.state.payments.find((x) => x.code === "PAY-E2E").status);
  check("另一项目经理签一级 → 审批中", lvl1 === "审批中", lvl1);

  // 财务签二级并付款
  await actor("finance", "吴财务");
  await page.click(`[data-approve="${payId}"]`);
  await sleep(120);
  const approved = await page.evaluate(() => window.__digitdesk.store.state.payments.find((x) => x.code === "PAY-E2E").status);
  check("财务签二级 → 已批准", approved === "已批准", approved);

  await page.click(`[data-pay-now="${payId}"]`);
  await sleep(200);
  const finalPay = await page.evaluate(() => {
    const p = window.__digitdesk.store.state.payments.find((x) => x.code === "PAY-E2E");
    return { status: p.status, serial: p.serial };
  });
  check("财务确认付款 → 已付款且生成流水号", finalPay.status === "已付款" && /^PAY-\d+$/.test(finalPay.serial || ""), JSON.stringify(finalPay));

  /* ---- 6. 刷新恢复：已提交数据仍在 ---- */
  await page.reload({ waitUntil: "networkidle" });
  await sleep(200);
  const afterReload = await page.evaluate(() => {
    const p = window.__digitdesk.store.state.payments.find((x) => x.code === "PAY-E2E");
    const r = window.__digitdesk.store.state.reels.find((x) => x.code === "R-S-01");
    return { pay: p && p.status, importedReel: !!r, rev: window.__digitdesk.store.rev };
  });
  check("刷新后已付款单仍在且状态为已付款", afterReload.pay === "已付款", JSON.stringify(afterReload));
  check("刷新后导入数据仍在", afterReload.importedReel);

  /* ---- 7. 刷新恢复：未提交付款草稿 ---- */
  await page.click('#tabs [data-tab="payments"]');
  await actor("pm", "孙经理");
  await page.click("#newPaymentBtn");
  await page.fill('#paymentForm [name="code"]', "PAY-DRAFT-E2E");
  await page.dispatchEvent('#paymentForm [name="code"]', "input");
  const b1 = await page.evaluate(() => window.__digitdesk.store.state.batches.find((b) => b.code === "B-001").id);
  await page.check(`#paymentForm input[name="batch"][value="${b1}"]`);
  await page.fill('#paymentForm [name="note"]', "刷新前未写完备注");
  await page.dispatchEvent('#paymentForm [name="note"]', "input");
  await sleep(100);

  await page.reload({ waitUntil: "networkidle" });
  await sleep(200);
  await page.click('#tabs [data-tab="io"]');
  const draftRow = page.locator('[data-draft-recover^="payment:"]').first();
  check("刷新后导入导出页列出未提交付款草稿", await draftRow.count() > 0);
  await draftRow.click();
  await sleep(150);
  const draftNote = await page.inputValue('#paymentForm [name="note"]');
  const draftBatchChecked = await page.isChecked(`#paymentForm input[name="batch"][value="${b1}"]`);
  check("草稿备注恢复", draftNote === "刷新前未写完备注", draftNote);
  check("草稿勾选批次恢复", draftBatchChecked);

  /* ---- 8. 双页竞争：真实两个标签页争用同一条合同的编辑锁 ---- */
  const page2 = await ctx.newPage();
  const e2 = [];
  page2.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon/i.test(m.text())) e2.push(m.text()); });
  page2.on("pageerror", (x) => e2.push("PAGEERROR: " + x.message));
  page2.on("dialog", (d) => d.accept(""));
  await page2.goto(BASE, { waitUntil: "networkidle" });
  await sleep(200);

  // 第一页打开合同编辑（获取锁）
  await page.click('#tabs [data-tab="records"]');
  await page.click('#recordsSeg [data-seg="contract"]');
  const cid = await page.evaluate(() => window.__digitdesk.store.state.contracts[0].id);
  await page.click(`[data-edit="contract|${cid}"]`);
  await sleep(80);
  const lockHeld = await page.evaluate((id) => window.__digitdesk.store.listLocks().some((l) => l.entity === "contract" && l.id === id && l.mine), cid);
  check("第一页取得合同编辑锁", lockHeld);

  // 第二页尝试编辑同一条 → 必须被锁拦截，且不进入编辑态
  await page2.click('#tabs [data-tab="records"]');
  await page2.click('#recordsSeg [data-seg="contract"]');
  await page2.click(`[data-edit="contract|${cid}"]`);
  await sleep(150);
  const p2Toast = await page2.locator("#toastHost").innerText();
  check("第二页编辑同合同被编辑锁拦截", p2Toast.includes("编辑锁") || p2Toast.includes("编辑中") || p2Toast.includes("正被"), p2Toast.slice(0, 80));
  const p2NotEditing = await page2.evaluate((id) => {
    const { ui } = window.__digitdesk;
    return !(ui.editingRecord && ui.editingRecord.kind === "contract" && ui.editingRecord.id === id);
  }, cid);
  check("第二页未进入该合同编辑态", p2NotEditing);
  check("第二页无 JS 报错", e2.length === 0, e2.slice(0, 3).join(" | "));
  // 第一页取消并释放锁
  await page.click("#cancelRecordEdit").catch(() => {});
  await sleep(60);
  const lockReleased = !(await page.evaluate((id) => window.__digitdesk.store.listLocks().some((l) => l.entity === "contract" && l.id === id), cid));
  check("第一页释放锁后锁清除", lockReleased);
  // 锁释放后第二页可编辑
  await page2.click(`[data-edit="contract|${cid}"]`);
  await sleep(100);
  const p2NowEdits = await page2.evaluate((id) => {
    const { ui } = window.__digitdesk;
    return ui.editingRecord && ui.editingRecord.kind === "contract" && ui.editingRecord.id === id;
  }, cid);
  check("锁释放后第二页可正常编辑", p2NowEdits);

  // 跨页实时同步（BroadcastChannel）：第一页新增外包商，第二页不刷新即可见
  const crossCode = "V-BROWSER-SYNC-" + TZ;
  await page.evaluate((code) => {
    window.__digitdesk.commit({ type: "saveVendor", data: { code, name: "跨页同步商" } });
  }, crossCode);
  await sleep(250);
  const synced = await page2.evaluate((code) => !!window.__digitdesk.store.state.vendors.find((v) => v.code === code), crossCode);
  check("第一页提交通过 BroadcastChannel 实时同步到第二页", synced);
  await page2.close();

  /* ---- 9. 版本回滚：打点 → 新增 → 回滚 → 新增消失、审计记录 ---- */
  await page.click('#tabs [data-tab="history"]');
  await sleep(60);
  await page.click("#snapshotBtn");
  await sleep(100);
  const rolled = await page.evaluate(() => {
    const { store, commit } = window.__digitdesk;
    const r = commit({ type: "saveVendor", data: { code: "V-BROWSER-TMP", name: "回滚验证临时商" } });
    return !r.errors.length && !!store.state.vendors.find((v) => v.code === "V-BROWSER-TMP");
  });
  check("回滚前新增外包商成功", rolled);
  // 回滚到刚打的（最新）版本点
  await page.click("#snapshotList [data-rollback]");
  await sleep(200);
  const afterRollback = await page.evaluate(() => {
    const s = window.__digitdesk.store.state;
    return {
      gone: !s.vendors.find((v) => v.code === "V-BROWSER-TMP"),
      auditAction: s.audit[0].action
    };
  });
  check("回滚后临时外包商消失", afterRollback.gone);
  check("回滚动作写入审计", afterRollback.auditAction === "版本回滚", afterRollback.auditAction);

  check("整个流程无未捕获 JS 报错", errors.length === 0, errors.slice(0, 5).join(" | "));

  await browser.close();
  console.log(`[${TZ}] 失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error("E2E 致命错误：", e); process.exit(2); });
