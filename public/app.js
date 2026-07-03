const KEY = "wari-data-v2";
const emptyDb = () => ({ projects: [], members: [], expenses: [], expense_payments: [], items: [], item_members: [] });
const db = loadLocal();
let draftNames = [];
let currentSlide = 0;
let selectedStoreId = null;
let activeProjectId = null;
let isCloud = false;
let isSaving = false;

const now = () => new Date().toISOString();
const id = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const yen = (n) => `${Math.round(n || 0).toLocaleString("ja-JP")}円`;
const esc = (s) => String(s ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));

function loadLocal() {
  const empty = emptyDb();
  try {
    const data = { ...empty, ...JSON.parse(localStorage.getItem(KEY)) };
    migrateLegacyPayments(data);
    return data;
  } catch {
    return empty;
  }
}

function setDb(data) {
  const next = { ...emptyDb(), ...data };
  migrateLegacyPayments(next);
  Object.keys(emptyDb()).forEach((key) => {
    db[key] = Array.isArray(next[key]) ? next[key] : [];
  });
  localStorage.setItem(KEY, JSON.stringify(db));
}

function migrateLegacyPayments(data) {
  data.expenses.forEach((e) => {
    if (e.payer_member_id && !data.expense_payments.some((p) => p.expense_id === e.id)) {
      data.expense_payments.push({
        id: `legacy_${e.id}`,
        project_id: e.project_id,
        expense_id: e.id,
        member_id: e.payer_member_id,
        amount: e.total_amount,
        created_at: e.created_at,
      });
    }
  });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || "API error");
  return data;
}

async function bootCloud() {
  try {
    const data = await api("/api/projects");
    isCloud = true;
    const summaries = data.projects || [];
    db.projects = summaries.map((p) => ({ ...p, created_at: p.created_at || now() }));
    db.members = [];
    db.expenses = [];
    db.expense_payments = [];
    db.items = [];
    db.item_members = [];
    render();
  } catch {
    isCloud = false;
  }
}

function graphForProject(projectId) {
  return {
    projects: db.projects.filter((x) => x.id === projectId).map(({ member_count, expense_count, total_amount, ...p }) => p),
    members: db.members.filter((x) => x.project_id === projectId),
    expenses: db.expenses.filter((x) => x.project_id === projectId),
    expense_payments: db.expense_payments.filter((x) => x.project_id === projectId),
    items: db.items.filter((x) => x.project_id === projectId),
    item_members: db.item_members.filter((x) => x.project_id === projectId),
  };
}

async function loadProject(projectId) {
  if (!isCloud) return;
  const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  mergeProjectGraph(data);
}

async function loadSharedProject(token) {
  const data = await api(`/api/share/${encodeURIComponent(token)}`);
  isCloud = true;
  mergeProjectGraph(data);
  const projectId = data.projects?.[0]?.id;
  if (projectId) location.hash = `#/p/${projectId}`;
}

function mergeProjectGraph(data) {
  const projectId = data.projects?.[0]?.id;
  if (!projectId) return;
  for (const key of Object.keys(emptyDb())) {
    db[key] = db[key].filter((x) => (key === "projects" ? x.id : x.project_id) !== projectId);
    db[key].push(...(data[key] || []));
  }
  localStorage.setItem(KEY, JSON.stringify(db));
}

async function persistProject(projectId, msg) {
  localStorage.setItem(KEY, JSON.stringify(db));
  render();
  if (msg) toast(msg);
  if (!isCloud || !projectId) return;
  try {
    isSaving = true;
    renderStatus();
    await api(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PUT",
      body: JSON.stringify(graphForProject(projectId)),
    });
  } catch (err) {
    toast(`クラウド保存に失敗: ${err.message}`);
  } finally {
    isSaving = false;
    renderStatus();
  }
}

function toast(msg) {
  const t = document.querySelector("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 1600);
}

function pdata(pid) {
  return {
    members: db.members.filter((x) => x.project_id === pid),
    expenses: db.expenses.filter((x) => x.project_id === pid),
    payments: db.expense_payments.filter((x) => x.project_id === pid),
    items: db.items.filter((x) => x.project_id === pid),
    links: db.item_members.filter((x) => x.project_id === pid),
  };
}

function member(data, mid) {
  return data.members.find((x) => x.id === mid)?.name || "未設定";
}

function calculate(pid) {
  const d = pdata(pid);
  const burdens = Object.fromEntries(d.members.map((m) => [m.id, 0]));
  const advances = Object.fromEntries(d.members.map((m) => [m.id, 0]));
  const shares = {};
  d.payments.forEach((p) => (advances[p.member_id] = (advances[p.member_id] || 0) + p.amount));
  d.expenses.forEach((expense) => {
    const mids = d.members.map((m) => m.id);
    const base = mids.length ? Math.floor(expense.total_amount / mids.length) : 0;
    let rem = mids.length ? expense.total_amount % mids.length : 0;
    shares[expense.id] = mids.map((mid) => {
      const amount = base + (rem-- > 0 ? 1 : 0);
      burdens[mid] = (burdens[mid] || 0) + amount;
      return { mid, amount };
    });
  });
  const balances = d.members.map((m) => ({
    m,
    burden: burdens[m.id] || 0,
    advance: advances[m.id] || 0,
    balance: (advances[m.id] || 0) - (burdens[m.id] || 0),
  }));
  const debt = balances.filter((x) => x.balance < 0).map((x) => ({ ...x, left: -x.balance }));
  const credit = balances.filter((x) => x.balance > 0).map((x) => ({ ...x, left: x.balance }));
  const transfers = [];
  let a = 0;
  let b = 0;
  while (a < debt.length && b < credit.length) {
    const amount = Math.min(debt[a].left, credit[b].left);
    if (amount) transfers.push({ from: debt[a].m, to: credit[b].m, amount });
    debt[a].left -= amount;
    credit[b].left -= amount;
    if (!debt[a].left) a++;
    if (!credit[b].left) b++;
  }
  return { ...d, shares, balances, transfers };
}

function shell(body) {
  return `<div class="app"><header class="topbar"><div class="brand"><span class="logo">W</span>Wari</div><span id="save-status" class="meta">${statusText()}</span></header>${body}</div>`;
}

function statusText() {
  if (isSaving) return "保存中";
  return isCloud ? "クラウド保存" : "端末保存";
}

function renderStatus() {
  const el = document.querySelector("#save-status");
  if (el) el.textContent = statusText();
}

function ocrBox(target) {
  return `<div class="ocr-box"><label class="ocr-button"><input type="file" accept="image/*" capture="environment" data-ocr-target="${target}"><span>レシートから入力</span></label><div id="${target}-ocr-status" class="ocr-status"></div></div>`;
}

function renderHome() {
  const projects = db.projects
    .map((p) => {
      const d = pdata(p.id);
      const memberCount = p.member_count ?? d.members.length;
      const expenseCount = p.expense_count ?? d.expenses.length;
      return `<article class="project"><span class="project-icon">${esc(p.name[0])}</span><div class="project-info"><b>${esc(p.name)}</b><div class="meta">${memberCount}人 ・ ${expenseCount}店</div></div><button class="open" data-open="${p.id}" aria-label="${esc(p.name)}を開く">›</button></article>`;
    })
    .join("");
  return shell(`<main class="home"><div class="section-title home-title"><h1>新しい割り勘</h1></div><section class="quick-card"><div class="field"><label for="draft-project">プロジェクト名</label><input id="draft-project" class="input" placeholder="例：今日のごはん"></div><div class="field"><label for="draft-name">参加者</label><div class="name-add"><input id="draft-name" class="input" placeholder="名前を入力" autocomplete="off"><button class="square-btn" type="button" data-add-name aria-label="参加者を追加">＋</button></div><div id="draft-chips" class="chips">${draftNames.map((n, i) => `<span class="chip">${esc(n)}<button data-remove-name="${i}" aria-label="${esc(n)}を削除">×</button></span>`).join("")}</div></div><div class="two"><div class="field"><label for="draft-store">お店</label><input id="draft-store" class="input" placeholder="店名"></div><div class="field"><label for="draft-amount">金額</label><input id="draft-amount" class="input" type="number" min="1" inputmode="numeric" placeholder="0"></div></div>${ocrBox("draft")}<div class="field"><span class="label">支払者</span><div class="payer-pills">${draftNames.length ? draftNames.map((n, i) => `<label class="payer"><input type="radio" name="draft-payer" value="${i}" ${i === 0 ? "checked" : ""}><span>${esc(n)}</span></label>`).join("") : `<span class="meta">参加者を追加</span>`}</div></div><div class="quick-actions"><button class="btn primary" data-quick="equal">はじめる</button></div></section><section class="recent"><div class="section-title"><h2>最近の割り勘</h2><span>${db.projects.length}件</span></div><div class="project-list">${projects || `<div class="empty">まだありません</div>`}</div></section></main>`);
}

function nav() {
  return `<nav class="step-nav">${["参加者", "お店", "精算"].map((n, i) => `<button class="step ${i === currentSlide ? "active" : ""}" data-slide="${i}">${n}</button>`).join("")}</nav>`;
}

function membersSlide(p, d) {
  return `<section class="slide" data-index="0"><h2>参加者</h2><form id="member-form" class="sheet"><div class="name-add"><input id="member-name" class="input" required placeholder="名前を入力"><button class="square-btn" aria-label="参加者を追加">＋</button></div></form><div class="stack">${d.members.map((m, i) => `<div class="row"><span class="avatar">${i + 1}</span><div class="row-main"><b class="editable-text" data-edit-member="${m.id}" title="ダブルクリックで修正">${esc(m.name)}</b></div><button class="btn danger small" data-del-member="${m.id}">削除</button></div>`).join("") || `<div class="empty">参加者を追加</div>`}</div></section>`;
}

function storesSlide(p, d) {
  const store = d.expenses.find((e) => e.id === selectedStoreId);
  if (store) {
    const payments = d.payments.filter((x) => x.expense_id === store.id);
    const paymentTotal = payments.reduce((s, x) => s + x.amount, 0);
    const memberOptions = d.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
    return `<section class="slide store-detail" data-index="1"><button class="detail-back" data-store-back>← お店一覧</button><div class="store-heading"><div><h2 class="editable-text" data-edit-store-name="${store.id}" title="ダブルクリックで修正">${esc(store.store_name)}</h2><div class="meta">${store.paid_at}</div></div><div class="store-total"><small>合計</small><b class="amount editable-amount" data-edit-store-total="${store.id}" title="ダブルクリックで修正">${yen(store.total_amount)}</b></div></div><section class="account-section"><h3>支払い</h3><form id="payment-form" class="compact-form"><input id="payment-expense" type="hidden" value="${store.id}"><select id="payment-member" required>${memberOptions}</select><input id="payment-amount" class="input" type="number" min="1" inputmode="numeric" required placeholder="金額"><button class="square-btn" aria-label="支払いを追加">＋</button></form><div class="payment-lines">${payments.map((x) => `<div class="payment-row"><span>${esc(member(d, x.member_id))}</span><b class="payment-amount editable-amount" data-edit-payment="${x.id}" title="ダブルクリックで修正">${yen(x.amount)}</b><button class="ghost" data-del-payment="${x.id}" aria-label="${esc(member(d, x.member_id))}の支払いを削除">×</button></div>`).join("") || `<div class="empty">支払いを入力</div>`}</div></section><div class="receipt-total"><div><span>お店の合計</span><b class="editable-amount" data-edit-store-total="${store.id}" title="ダブルクリックで修正">${yen(store.total_amount)}</b></div><div><span>支払い合計</span><b>${yen(paymentTotal)}</b></div>${store.total_amount !== paymentTotal ? `<div class="difference"><span>支払いの残り</span><b>${yen(store.total_amount - paymentTotal)}</b></div>` : ""}</div><button class="btn danger store-delete" data-del-expense="${store.id}">このお店を削除</button></section>`;
  }
  const opts = d.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  const cards = d.expenses
    .map((e) => {
      const payers = [...new Set(d.payments.filter((x) => x.expense_id === e.id).map((x) => member(d, x.member_id)))].join("・");
      return `<div class="store-card" data-store="${e.id}" role="button" tabindex="0"><span class="store-icon">店</span><span class="store-card-main"><b>${esc(e.store_name)}</b><small>${esc(payers || "支払い未入力")}</small></span><span class="amount">${yen(e.total_amount)}</span><span class="chevron">›</span></div>`;
    })
    .join("");
  return `<section class="slide" data-index="1"><div class="section-title"><h2>お店</h2><span>${d.expenses.length}店</span></div><form id="expense-form" class="sheet"><h3>お店を追加</h3><div class="field"><label for="store">店名</label><input id="store" class="input" required placeholder="例：ローソン"></div><div class="two"><div class="field"><label for="amount">合計金額</label><input id="amount" class="input" type="number" min="1" inputmode="numeric" required placeholder="0"></div><div class="field"><label for="payer">最初の支払者</label><select id="payer" required>${opts}</select></div></div>${ocrBox("expense")}<button class="btn primary" ${d.members.length ? "" : "disabled"}>追加</button></form><div class="store-list">${cards || `<div class="empty">お店を追加</div>`}</div></section>`;
}

function settlementSlide(p, d, c) {
  const et = d.expenses.reduce((s, x) => s + x.total_amount, 0);
  return `<section class="slide" data-index="2"><h2>支払い</h2><div>${c.transfers.map((t) => `<div class="transfer"><b>${esc(t.from.name)}</b><span class="arrow">→</span><b>${esc(t.to.name)}</b><span class="amount">${yen(t.amount)}</span></div>`).join("") || `<div class="empty">支払いなし</div>`}</div><div class="section-title" style="margin-top:24px"><h2>精算</h2></div><div class="summary"><div class="metric"><span>お店の合計</span><b>${yen(et)}</b></div><div class="metric"><span>参加者</span><b>${d.members.length}人</b></div></div><div class="stack">${c.balances.map((x) => `<div class="row balance"><div class="row-main"><b>${esc(x.m.name)}</b></div><div class="balance-values"><div><span>負担</span>${yen(x.burden)}</div><div><span>立替</span>${yen(x.advance)}</div><div><span>差額</span><b class="${x.balance >= 0 ? "plus" : "minus"}">${x.balance > 0 ? "+" : ""}${yen(x.balance)}</b></div></div></div>`).join("")}</div><div style="margin-top:16px"><button class="btn secondary" data-share-project="${p.id}">共有リンクを作る</button></div><div id="share-box" class="share-box"></div><div style="margin-top:18px"><button class="btn danger" data-delete-project="${p.id}">プロジェクトを削除</button></div></section>`;
}

function renderDetail(p) {
  const d = pdata(p.id);
  const c = calculate(p.id);
  return `<div class="detail"><div class="project-head"><div class="head-row"><button class="back" data-home aria-label="一覧へ">←</button><h1>${esc(p.name)}</h1><span class="status-dot" title="${statusText()}"></span></div></div>${nav()}<main class="slides" id="slides">${membersSlide(p, d)}${storesSlide(p, d)}${settlementSlide(p, d, c)}</main></div>`;
}

function project() {
  const pid = location.hash.match(/^#\/p\/(.+)$/)?.[1];
  return db.projects.find((x) => x.id === pid);
}

function render() {
  const p = project();
  document.querySelector("#app").innerHTML = p ? renderDetail(p) : renderHome();
  if (p) {
    const slides = document.querySelector("#slides");
    slides.style.scrollBehavior = "auto";
    slides.scrollLeft = currentSlide * slides.clientWidth;
    requestAnimationFrame(() => {
      slides.style.scrollBehavior = "";
    });
    slides.addEventListener(
      "scroll",
      () => {
        clearTimeout(slides.t);
        slides.t = setTimeout(() => {
          const i = Math.round(slides.scrollLeft / slides.clientWidth);
          if (i !== currentSlide) {
            currentSlide = i;
            document.querySelectorAll(".step").forEach((x, n) => x.classList.toggle("active", n === i));
          }
        }, 70);
      },
      { passive: true }
    );
  }
}

async function route() {
  const share = location.hash.match(/^#\/join\/(.+)$/)?.[1];
  if (share) {
    try {
      await loadSharedProject(share);
    } catch (err) {
      toast(`共有リンクを開けません: ${err.message}`);
      location.hash = "#/";
    }
    return;
  }
  const pid = location.hash.match(/^#\/p\/(.+)$/)?.[1];
  if (pid && activeProjectId !== pid) {
    activeProjectId = pid;
    selectedStoreId = null;
    currentSlide = 2;
  }
  if (!pid) activeProjectId = null;
  if (pid && isCloud && !db.members.some((x) => x.project_id === pid)) {
    try {
      await loadProject(pid);
    } catch (err) {
      toast(`読み込みに失敗: ${err.message}`);
    }
  }
  render();
}

function addDraftName() {
  const input = document.querySelector("#draft-name");
  const name = input.value.trim();
  if (!name) return;
  if (draftNames.includes(name)) return toast("同じ名前があります");
  draftNames.push(name);
  render();
  requestAnimationFrame(() => document.querySelector("#draft-name")?.focus());
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function setOcrStatus(target, msg, type = "") {
  const el = document.querySelector(`#${target}-ocr-status`);
  if (el) {
    el.textContent = msg;
    el.className = `ocr-status ${type}`.trim();
  }
}

async function handleReceiptOcr(input) {
  const file = input.files?.[0];
  const target = input.dataset.ocrTarget;
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    setOcrStatus(target, "画像は8MB以下にしてください", "error");
    return;
  }
  setOcrStatus(target, "読み取り中...");
  try {
    const image_data_url = await fileToDataUrl(file);
    const res = await fetch("/api/ocr-receipt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image_data_url }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "読み取れませんでした");
    const storeInput = document.querySelector(target === "draft" ? "#draft-store" : "#store");
    const amountInput = document.querySelector(target === "draft" ? "#draft-amount" : "#amount");
    if (data.store_name && storeInput) storeInput.value = data.store_name;
    if (data.total_amount && amountInput) amountInput.value = data.total_amount;
    setOcrStatus(target, `読み取りました。確認してください。${data.notes || ""}`, "ok");
    toast("レシートを読み取りました");
  } catch (err) {
    setOcrStatus(target, err.message || "読み取りに失敗しました", "error");
    toast("OCRに失敗しました");
  } finally {
    input.value = "";
  }
}

async function createQuick() {
  const amount = Number(document.querySelector("#draft-amount").value);
  const store = document.querySelector("#draft-store").value.trim();
  const payerIndex = Number(document.querySelector('[name="draft-payer"]:checked')?.value ?? 0);
  if (draftNames.length < 2) return toast("参加者を2人以上追加してください");
  if (!amount || !store) return toast("店名と金額を入力してください");
  const p = { id: id("prj"), name: document.querySelector("#draft-project").value.trim() || `${new Date().getMonth() + 1}月${new Date().getDate()}日の割り勘`, created_at: now() };
  const members = draftNames.map((name) => ({ id: id("mem"), project_id: p.id, name, created_at: now() }));
  const expense = { id: id("exp"), project_id: p.id, payer_member_id: null, store_name: store, total_amount: amount, paid_at: now().slice(0, 10), receipt_image_url: null, created_at: now() };
  db.projects.unshift(p);
  db.members.push(...members);
  db.expenses.push(expense);
  db.expense_payments.push({ id: id("pay"), project_id: p.id, expense_id: expense.id, member_id: members[payerIndex].id, amount, created_at: now() });
  draftNames = [];
  selectedStoreId = null;
  currentSlide = 2;
  localStorage.setItem(KEY, JSON.stringify(db));
  if (isCloud) {
    try {
      await api("/api/projects", { method: "POST", body: JSON.stringify(graphForProject(p.id)) });
    } catch (err) {
      toast(`クラウド作成に失敗: ${err.message}`);
    }
  }
  location.hash = `#/p/${p.id}`;
  render();
  toast("作成しました");
}

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const p = project();
  if (!p) return;
  if (e.target.id === "member-form") {
    db.members.push({ id: id("mem"), project_id: p.id, name: document.querySelector("#member-name").value.trim(), created_at: now() });
    persistProject(p.id, "参加者を追加しました");
  }
  if (e.target.id === "expense-form") {
    const amount = Number(document.querySelector("#amount").value);
    const expense = { id: id("exp"), project_id: p.id, payer_member_id: null, store_name: document.querySelector("#store").value.trim(), total_amount: amount, paid_at: now().slice(0, 10), receipt_image_url: null, created_at: now() };
    db.expenses.push(expense);
    db.expense_payments.push({ id: id("pay"), project_id: p.id, expense_id: expense.id, member_id: document.querySelector("#payer").value, amount, created_at: now() });
    selectedStoreId = expense.id;
    persistProject(p.id, "お店を追加しました");
  }
  if (e.target.id === "payment-form") {
    db.expense_payments.push({ id: id("pay"), project_id: p.id, expense_id: document.querySelector("#payment-expense").value, member_id: document.querySelector("#payment-member").value, amount: Number(document.querySelector("#payment-amount").value), created_at: now() });
    persistProject(p.id, "支払いを追加しました");
  }
});

document.addEventListener("click", async (e) => {
  const storeCard = e.target.closest(".store-card");
  if (storeCard) {
    selectedStoreId = storeCard.dataset.store;
    currentSlide = 1;
    render();
    return;
  }
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.addName !== undefined) addDraftName();
  if (t.dataset.removeName !== undefined) {
    draftNames.splice(Number(t.dataset.removeName), 1);
    render();
  }
  if (t.dataset.quick) createQuick();
  if (t.dataset.open) {
    selectedStoreId = null;
    currentSlide = 2;
    location.hash = `#/p/${t.dataset.open}`;
  }
  if (t.dataset.home !== undefined) {
    selectedStoreId = null;
    currentSlide = 0;
    location.hash = "#/";
  }
  if (t.dataset.store) {
    selectedStoreId = t.dataset.store;
    currentSlide = 1;
    render();
  }
  if (t.dataset.storeBack !== undefined) {
    selectedStoreId = null;
    currentSlide = 1;
    render();
  }
  if (t.dataset.slide !== undefined) {
    currentSlide = Number(t.dataset.slide);
    if (currentSlide !== 1) selectedStoreId = null;
    const s = document.querySelector("#slides");
    s.scrollTo({ left: s.clientWidth * currentSlide, behavior: "smooth" });
    document.querySelectorAll(".step").forEach((x, n) => x.classList.toggle("active", n === currentSlide));
  }
  const p = project();
  if (t.dataset.delPayment && p) {
    db.expense_payments = db.expense_payments.filter((x) => x.id !== t.dataset.delPayment);
    persistProject(p.id, "支払いを削除しました");
  }
  if (t.dataset.delExpense && p) {
    const ids = db.items.filter((x) => x.expense_id === t.dataset.delExpense).map((x) => x.id);
    db.expenses = db.expenses.filter((x) => x.id !== t.dataset.delExpense);
    db.expense_payments = db.expense_payments.filter((x) => x.expense_id !== t.dataset.delExpense);
    db.items = db.items.filter((x) => x.expense_id !== t.dataset.delExpense);
    db.item_members = db.item_members.filter((x) => !ids.includes(x.item_id));
    selectedStoreId = null;
    persistProject(p.id, "お店を削除しました");
  }
  if (t.dataset.delMember && p) {
    if (db.expense_payments.some((x) => x.member_id === t.dataset.delMember)) return toast("支払者なので削除できません");
    db.members = db.members.filter((x) => x.id !== t.dataset.delMember);
    db.item_members = db.item_members.filter((x) => x.member_id !== t.dataset.delMember);
    persistProject(p.id, "参加者を削除しました");
  }
  if (t.dataset.shareProject) {
    if (!isCloud) return toast("共有リンクはCloudflare版で使えます");
    try {
      const share = await api(`/api/projects/${encodeURIComponent(t.dataset.shareProject)}/share`, { method: "POST" });
      const url = `${location.origin}${location.pathname}#/join/${share.token}`;
      const box = document.querySelector("#share-box");
      if (box) box.innerHTML = `<div class="share-url">${esc(url)}</div>`;
      await navigator.clipboard?.writeText(url);
      toast("共有リンクをコピーしました");
    } catch (err) {
      toast(`共有リンク作成に失敗: ${err.message}`);
    }
  }
  if (t.dataset.deleteProject && confirm("このプロジェクトを削除しますか？")) {
    const pid = t.dataset.deleteProject;
    if (isCloud) {
      try {
        await api(`/api/projects/${encodeURIComponent(pid)}`, { method: "DELETE" });
      } catch (err) {
        toast(`クラウド削除に失敗: ${err.message}`);
      }
    }
    for (const key of Object.keys(emptyDb())) db[key] = db[key].filter((x) => (key === "projects" ? x.id : x.project_id) !== pid);
    localStorage.setItem(KEY, JSON.stringify(db));
    location.hash = "#/";
    render();
  }
});

document.addEventListener("dblclick", (e) => {
  const textEl = e.target.closest("[data-edit-member], [data-edit-store-name]");
  if (textEl) {
    const p = project();
    const record = editableTextRecord(textEl);
    if (!p || !record) return;
    const input = document.createElement("input");
    input.className = "input inline-text";
    input.type = "text";
    input.value = record.value;
    input.dataset.textEditKind = record.kind;
    input.dataset.textEditId = record.id;
    textEl.replaceWith(input);
    input.focus();
    input.select();
    return;
  }
  const el = e.target.closest("[data-edit-payment], [data-edit-store-total]");
  const p = project();
  if (!el || !p) return;
  const record = editableAmountRecord(el);
  if (!record) return;
  const input = document.createElement("input");
  input.className = "input inline-amount";
  input.type = "number";
  input.min = "1";
  input.inputMode = "numeric";
  input.value = record.value;
  input.dataset.amountEditKind = record.kind;
  input.dataset.amountEditId = record.id;
  el.replaceWith(input);
  input.focus();
  input.select();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "draft-name") {
    e.preventDefault();
    addDraftName();
  }
  if (e.target.dataset.amountEditId) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.dataset.amountEditDone = "1";
      commitAmountEdit(e.target);
    }
    if (e.key === "Escape") {
      e.target.dataset.amountEditCancel = "1";
      render();
    }
  }
  if (e.target.dataset.textEditId) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.dataset.textEditDone = "1";
      commitTextEdit(e.target);
    }
    if (e.key === "Escape") {
      e.target.dataset.textEditCancel = "1";
      render();
    }
  }
});

document.addEventListener("blur", (e) => {
  if (e.target.dataset.amountEditCancel || e.target.dataset.amountEditDone) return;
  if (e.target.dataset.amountEditId) commitAmountEdit(e.target);
  if (e.target.dataset.textEditCancel || e.target.dataset.textEditDone) return;
  if (e.target.dataset.textEditId) commitTextEdit(e.target);
}, true);

function editableTextRecord(el) {
  if (el.dataset.editMember) {
    const person = db.members.find((x) => x.id === el.dataset.editMember);
    return person ? { kind: "member", id: person.id, value: person.name } : null;
  }
  if (el.dataset.editStoreName) {
    const store = db.expenses.find((x) => x.id === el.dataset.editStoreName);
    return store ? { kind: "storeName", id: store.id, value: store.store_name } : null;
  }
  return null;
}

function commitTextEdit(input) {
  const p = project();
  if (!p) return render();
  const value = input.value.trim();
  if (!value) return render();
  if (input.dataset.textEditKind === "member") {
    const person = db.members.find((x) => x.id === input.dataset.textEditId);
    if (!person) return render();
    person.name = value;
    persistProject(p.id, "参加者名を修正しました");
    return;
  }
  if (input.dataset.textEditKind === "storeName") {
    const store = db.expenses.find((x) => x.id === input.dataset.textEditId);
    if (!store) return render();
    store.store_name = value;
    persistProject(p.id, "お店の名前を修正しました");
  }
}

function editableAmountRecord(el) {
  if (el.dataset.editPayment) {
    const payment = db.expense_payments.find((x) => x.id === el.dataset.editPayment);
    return payment ? { kind: "payment", id: payment.id, value: payment.amount } : null;
  }
  if (el.dataset.editStoreTotal) {
    const store = db.expenses.find((x) => x.id === el.dataset.editStoreTotal);
    return store ? { kind: "store", id: store.id, value: store.total_amount } : null;
  }
  return null;
}

function commitAmountEdit(input) {
  const p = project();
  if (!p) return render();
  const amount = Number(input.value);
  if (!amount || amount < 1) return render();
  if (input.dataset.amountEditKind === "payment") {
    const payment = db.expense_payments.find((x) => x.id === input.dataset.amountEditId);
    if (!payment) return render();
    payment.amount = amount;
    persistProject(p.id, "支払い金額を修正しました");
    return;
  }
  if (input.dataset.amountEditKind === "store") {
    const store = db.expenses.find((x) => x.id === input.dataset.amountEditId);
    if (!store) return render();
    store.total_amount = amount;
    persistProject(p.id, "お店の合計を修正しました");
  }
}

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-ocr-target]")) handleReceiptOcr(e.target);
});
window.addEventListener("hashchange", route);
if (!location.hash) location.hash = "#/";
render();
bootCloud().then(route);
