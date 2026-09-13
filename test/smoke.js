"use strict";
const { createWindow, $id } = require("./harness.js");

const { win, doc } = createWindow({ role: "pm", user: "孙经理" });
console.log("loaded. tabs:", doc.querySelectorAll("#tabs button").length);
console.log("rev badge:", $id(doc, "revBadge").textContent);
console.log("stat cards:", doc.querySelectorAll(".stat-card").length);
console.log("pipe cols:", doc.querySelectorAll(".pipe-col").length);
console.log("budget rows:", doc.querySelectorAll(".budget-row").length);
console.log("audit rows:", doc.querySelectorAll(".audit-table tbody tr").length);
console.log("role:", win.__digitdesk.store.role, win.__digitdesk.store.state.batches.length, "batches");

// switch tab to acceptance
doc.querySelector('[data-tab="acceptance"]').click();
console.log("batch cards:", doc.querySelectorAll(".batch-card").length);
console.log("trans buttons sample:", doc.querySelector(".batch-card .row-actions")?.textContent?.slice(0, 60));
