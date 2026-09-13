/*
 * harness.js —— 在 Node 中构造“浏览器页面”加载真实 ui.js 进行点击级走查。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Document, FormData, ShimFileReader, ShimBlob, ShimURL } = require("./dom-shim.js");
const { memoryStorage } = require("../js/store.js");

const ROOT = path.join(__dirname, "..");
const CORE_JS = fs.readFileSync(path.join(ROOT, "js/core.js"), "utf8");
const STORE_JS = fs.readFileSync(path.join(ROOT, "js/store.js"), "utf8");
const UI_JS = fs.readFileSync(path.join(ROOT, "js/ui.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

function createWindow(opts) {
  opts = opts || {};
  const storageListeners = [];
  const winListeners = {};
  const { memoryBus } = require("../js/store.js");
  const sharedBus = opts.shared && opts.shared.bus;
  const bus = sharedBus || (opts.withBus === false ? null : memoryBus());
  const localStorage = (opts.shared && opts.shared.storage) || memoryStorage();

  const win = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    structuredClone: (x) => structuredClone(x),
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    Error,
    Promise,
    Buffer,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    crypto: { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2, 10) },
    localStorage,
    sessionStorage: memoryStorage(),
    FormData,
    FileReader: ShimFileReader,
    Blob: ShimBlob,
    URL: ShimURL,
    confirm: () => true,
    prompt: () => null,
    alert: () => {},
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    BroadcastChannel: undefined,
    CustomEvent: class CustomEvent {
      constructor(type, o) { this.type = type; this.detail = (o || {}).detail; }
    },
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener() {},
    __storageListeners: storageListeners,
    __winListeners: winListeners
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.globalThis = win;

  const doc = new Document(HTML, win);
  win.document = doc;
  win.__digitdeskBus = bus;
  win.__digitdeskPageId = opts.pageId;
  win.__digitdeskTabName = opts.tabName;

  // storage 事件支持：外部调用 page.fireStorage(ev)
  win.fireStorage = (ev) => {
    for (const fn of winListeners.storage || []) fn(ev);
  };

  // ui.js / store.js 通过 localStorage.getItem('digitdesk:role'...) 读角色
  if (opts.role) localStorage.setItem("digitdesk:role", opts.role);
  if (opts.user) localStorage.setItem("digitdesk:user", opts.user);

  const context = vm.createContext(win);
  vm.runInContext(CORE_JS, context, { filename: "core.js" });
  vm.runInContext(STORE_JS, context, { filename: "store.js" });
  vm.runInContext(UI_JS, context, { filename: "ui.js" });

  return { win, doc };
}

/* ---------------- 断言 ---------------- */

let passed = 0;
let failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failures.push(msg); throw new Error("断言失败：" + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`); }
function includes(haystack, needle, msg) { ok(String(haystack).includes(needle), `${msg}（应包含「${needle}」，实际：${String(haystack).slice(0, 200)}）`); }
function notIncludes(haystack, needle, msg) { ok(!String(haystack).includes(needle), `${msg}（不应包含「${needle}」）`); }
function summary() {
  return { passed, failures, assertCount: () => passed + failures.length };
}
function resetCounters() { passed = 0; failures = []; }

/* ---------------- 页面操作辅助 ---------------- */

function $id(doc, id) {
  const el = doc.getElementById(id);
  if (!el) throw new Error("找不到 #" + id);
  return el;
}
function clickEl(el, extra) { el.click(extra || {}); }
function clickText(doc, selector, text) {
  const el = doc.querySelectorAll(selector).find((x) => x.textContent.includes(text));
  if (!el) throw new Error(`找不到按钮「${text}」（${selector}）`);
  clickEl(el);
  return el;
}
function setValue(el, value) {
  el.value = String(value);
  el.dispatch({ type: "input" });
  el.dispatch({ type: "change" });
}
function setSelect(el, value) {
  el.value = String(value);
  el.dispatch({ type: "change" });
}
function check(el, on) {
  el.checked = !!on;
  el.dispatch({ type: "change" });
  el.dispatch({ type: "click" });
}
function submitForm(formEl, submitterName) {
  let submitter = null;
  if (submitterName) submitter = formEl.querySelector(`button[value="${submitterName}"]`) || formEl.querySelector(`[name="${submitterName}"]`);
  const ev = { type: "submit", submitter: submitter || formEl.querySelector("button.primary") || formEl.querySelector("button") };
  let prevented = false;
  ev.preventDefault = () => { prevented = true; ev.defaultPrevented = true; };
  formEl.dispatch(ev);
  return { prevented };
}
function formDataToObject(formEl) {
  const fd = new FormData(formEl);
  const o = {};
  fd.forEach((v, k) => (o[k] = v));
  return o;
}

/** 等待 setTimeout(0) 等异步回调 */
const tick = () => new Promise((r) => setTimeout(r, 2));

/** 读取该页 store 的内部状态（通过 DOM 上无法直接拿，走全局暴露的测试钩子） */
function getStore(win) { return win.__digitdeskStore; }

/* 让 ui.js 把 store 挂到 window 上，方便断言。用 monkey patch 方式在 vm 外抓取。 */
function installStoreHook(win) {
  // ui.js 里 const store = new Store(...)；在 vm 里我们用包装方式：重跑一个探针
  // 更简单：在 UI_JS 末尾追加挂出语句。
}

module.exports = {
  createWindow,
  ok, eq, includes, notIncludes, summary, resetCounters,
  $id, clickEl, clickText, setValue, setSelect, check, submitForm, formDataToObject, tick,
  UI_JS, HTML
};
