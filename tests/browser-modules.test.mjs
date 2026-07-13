import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WariStorage = require("../public/modules/storage.js");
const WariSplit = require("../public/modules/split.js");
const WariImports = require("../public/modules/imports.js");
const WariHousehold = require("../public/modules/household.js");
const WariApi = require("../public/modules/api.js");

const T1 = "2026-07-01T09:00:00.000Z";
const T2 = "2026-07-02T09:00:00.000Z";

function householdState() {
  return WariHousehold.createHouseholdProject(
    WariStorage.createEmptyState(),
    { id: "home", name: "個人家計簿", owner_member_id: "self" },
    { now: T1, storage: WariStorage },
  );
}

function linkedSplitState() {
  const state = householdState();
  state.projects.push({
    id: "split",
    name: "旅行",
    project_type: "split",
    currency: "JPY",
    share_token: null,
    share_role: "editor",
    share_expires_at: null,
    finalized_at: null,
    created_at: T1,
    updated_at: T1,
  });
  state.project_members.push(
    {
      id: "alice",
      project_id: "split",
      display_name: "A",
      role: "member",
      is_active: 1,
      linked_household_project_id: null,
      linked_at: null,
      created_at: T1,
      updated_at: T1,
    },
    {
      id: "bob",
      project_id: "split",
      display_name: "B",
      role: "member",
      is_active: 1,
      linked_household_project_id: null,
      linked_at: null,
      created_at: T1,
      updated_at: T1,
    },
  );
  state.transactions.push({
    id: "source",
    project_id: "split",
    merchant_name: "市場",
    merchant_normalized: "市場",
    gross_amount: 200,
    paid_amount: 200,
    discount_amount: 0,
    point_amount: 0,
    category: "旅行",
    status: "confirmed",
    occurred_at: T1,
    settled_at: null,
    note: null,
    entry_type: "purchase",
    origin_project_id: null,
    origin_transaction_id: null,
    origin_member_id: null,
    generated_automatically: 0,
    created_at: T1,
    updated_at: T1,
  });
  state.transaction_payments.push({
    id: "source-payment",
    transaction_id: "source",
    payer_member_id: "alice",
    amount: 200,
    payment_method: "credit_card",
    payment_status: "confirmed",
    occurred_at: T1,
    created_at: T1,
    updated_at: T1,
  });
  state.transaction_items.push(
    {
      id: "food",
      transaction_id: "source",
      name: "食事",
      amount: 100,
      quantity: 1,
      item_type: "product",
      category: "食費",
      sort_order: 0,
      is_hidden: 0,
      created_at: T1,
      updated_at: T1,
    },
    {
      id: "train",
      transaction_id: "source",
      name: "電車",
      amount: 100,
      quantity: 1,
      item_type: "product",
      category: "交通費",
      sort_order: 1,
      is_hidden: 0,
      created_at: T1,
      updated_at: T1,
    },
  );
  state.item_allocations.push(
    { id: "food-a", transaction_item_id: "food", project_member_id: "alice", allocated_amount: 60, created_at: T1, updated_at: T1 },
    { id: "food-b", transaction_item_id: "food", project_member_id: "bob", allocated_amount: 40, created_at: T1, updated_at: T1 },
    { id: "train-a", transaction_item_id: "train", project_member_id: "alice", allocated_amount: 20, created_at: T1, updated_at: T1 },
    { id: "train-b", transaction_item_id: "train", project_member_id: "bob", allocated_amount: 80, created_at: T1, updated_at: T1 },
  );
  state.import_records.push({
    id: "source-import",
    project_id: "split",
    transaction_id: "source",
    source_type: "receipt",
    source_status: "linked",
    created_at: T1,
    updated_at: T1,
  });
  return WariHousehold.linkSplitMember(state, "alice", "home", { now: T1, storage: WariStorage });
}

test("画像を検査してData URLへ変換する", async () => {
  const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  const file = {
    name: "receipt.jpg",
    type: "image/jpeg",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  };
  assert.equal(WariImports.validateImageFile(file), file);
  assert.equal(await WariImports.readImageAsDataUrl(file), "data:image/jpeg;base64,/9j/2Q==");
  assert.throws(
    () => WariImports.validateImageFile({ ...file, type: "text/plain" }),
    (error) => error.code === "unsupported_image_type",
  );
  assert.throws(
    () => WariImports.validateImageFile({ ...file, size: WariImports.MAX_IMAGE_BYTES + 1 }),
    (error) => error.code === "image_too_large",
  );
});

test("CSVをUTF-8の後にShift_JISで復号する", () => {
  const utf8 = new TextEncoder().encode("店舗,金額\r\n市場,1200\r\n");
  assert.equal(WariImports.decodeCsvArrayBuffer(utf8), "店舗,金額\r\n市場,1200\r\n");
  const shiftJis = Uint8Array.of(0x82, 0xa0, 0x2c, 0x82, 0xa2, 0x0d, 0x0a);
  assert.equal(WariImports.decodeCsvArrayBuffer(shiftJis), "あ,い\r\n");
});

test("引用符、改行、区切り文字を保ったCSVプレビューを返す", () => {
  const text = '日付,店舗,金額\r\n2026-07-01,"店, 一号","1,200"\r\n2026-07-02,"複数\n行",500\r\n';
  assert.deepEqual(WariImports.parseCsvPreview(text), [
    ["日付", "店舗", "金額"],
    ["2026-07-01", "店, 一号", "1,200"],
    ["2026-07-02", "複数\n行", "500"],
  ]);
  assert.equal(WariImports.selectCsvSourceType("", "paypay-history.csv", []), "paypay_csv");
  assert.equal(WariImports.selectCsvSourceType("bank", "card.csv", []), "bank_csv");
  assert.equal(WariImports.selectCsvSourceType("", "unknown.csv", [["利用日", "カード番号"]]), "card_csv");
});

test("家計企画と手入力取引に本人、要約品目、支払い、配分を作る", () => {
  const empty = WariStorage.createEmptyState();
  let state = WariHousehold.createHouseholdProject(
    empty,
    { id: "home", name: "個人家計簿", owner_member_id: "self" },
    { now: T1, storage: WariStorage },
  );
  assert.equal(empty.projects.length, 0);
  assert.equal(state.projects[0].project_type, "household");
  assert.deepEqual(
    state.project_members.map((row) => [row.display_name, row.role]),
    [["自分", "owner"]],
  );
  state = WariHousehold.createManualHouseholdTransaction(
    state,
    "home",
    {
      id: "manual",
      payment_id: "manual-payment",
      summary_item_id: "manual-item",
      allocation_id: "manual-allocation",
      merchant_name: "書店",
      amount: 1500,
      category: "書籍",
      payment_method: "credit_card",
      occurred_at: T1,
    },
    { now: T1, storage: WariStorage },
  );
  assert.equal(state.transactions[0].paid_amount, 1500);
  assert.equal(state.transaction_items[0].item_type, "summary");
  assert.equal(state.transaction_payments[0].payer_member_id, "self");
  assert.equal(state.item_allocations[0].project_member_id, "self");
  assert.equal(WariSplit.validateProjectTransactions(state, "home").valid, true);
});

test("割り勘負担を家計取引へ繰り返し同期し、元品目と確定状態を引き継ぐ", () => {
  const linked = linkedSplitState();
  assert.equal(WariSplit.validateProjectTransactions(linked, "split").valid, true);
  const provisional = WariHousehold.synchronizeSplitAllocations(linked, "split", {
    now: T1,
    storage: WariStorage,
  });
  assert.equal(linked.transactions.length, 1);
  const generated = provisional.transactions.find((row) => row.generated_automatically === 1);
  assert.equal(generated.status, "provisional");
  assert.equal(generated.paid_amount, 80);
  const generatedItems = provisional.transaction_items.filter((row) => row.transaction_id === generated.id);
  assert.deepEqual(
    generatedItems.map((row) => [row.name, row.amount, row.category]),
    [["食事", 60, "食費"], ["電車", 20, "交通費"]],
  );
  assert.equal(
    provisional.item_allocations
      .filter((row) => generatedItems.some((item) => item.id === row.transaction_item_id))
      .every((row) => row.project_member_id === "self"),
    true,
  );
  const synchronizedAgain = WariHousehold.synchronizeSplitAllocations(provisional, "split", {
    now: T2,
    storage: WariStorage,
  });
  assert.equal(synchronizedAgain.transactions.filter((row) => row.generated_automatically === 1).length, 1);
  assert.equal(synchronizedAgain.transaction_items.filter((row) => row.transaction_id === generated.id).length, 2);
  let finalized = WariHousehold.finalizeProjectState(linked, "split", {
    now: T2,
    storage: WariStorage,
    split: WariSplit,
  });
  finalized = WariHousehold.synchronizeSplitAllocations(finalized, "split", { now: T2, storage: WariStorage });
  assert.equal(finalized.transactions.find((row) => row.generated_automatically === 1).status, "confirmed");
  let reopened = WariHousehold.reopenProjectState(finalized, "split", { now: T2, storage: WariStorage });
  reopened = WariHousehold.synchronizeSplitAllocations(reopened, "split", { now: T2, storage: WariStorage });
  assert.equal(reopened.transactions.find((row) => row.generated_automatically === 1).status, "provisional");
});

test("負担額がゼロになった派生取引と、削除された元取引の派生取引を取り消す", () => {
  let state = WariHousehold.synchronizeSplitAllocations(linkedSplitState(), "split", {
    now: T1,
    storage: WariStorage,
  });
  state.item_allocations.find((row) => row.id === "food-a").allocated_amount = 0;
  state.item_allocations.find((row) => row.id === "food-b").allocated_amount = 100;
  state.item_allocations.find((row) => row.id === "train-a").allocated_amount = 0;
  state.item_allocations.find((row) => row.id === "train-b").allocated_amount = 100;
  const zeroBurden = WariHousehold.synchronizeSplitAllocations(state, "split", {
    now: T2,
    storage: WariStorage,
  });
  const cancelled = zeroBurden.transactions.find((row) => row.generated_automatically === 1);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.paid_amount, 0);
  assert.equal(
    zeroBurden.transaction_payments.find((row) => row.transaction_id === cancelled.id).payment_status,
    "cancelled",
  );
  const synchronized = WariHousehold.synchronizeSplitAllocations(linkedSplitState(), "split", {
    now: T1,
    storage: WariStorage,
  });
  const deleted = WariHousehold.deleteSourceTransaction(synchronized, "split", "source", {
    now: T2,
    storage: WariStorage,
  });
  assert.equal(deleted.transactions.some((row) => row.id === "source"), false);
  assert.equal(deleted.transactions.find((row) => row.generated_automatically === 1).status, "cancelled");
  assert.equal(deleted.transactions.find((row) => row.generated_automatically === 1).origin_transaction_id, null);
  assert.equal(deleted.import_records[0].transaction_id, null);
  assert.equal(deleted.transaction_items.some((row) => row.id === "food" || row.id === "train"), false);
});

test("APIクライアントが行単位経路と取込・集計・共有経路を呼び分ける", async () => {
  const calls = [];
  const client = WariApi.createApiClient({
    baseUrl: "/api",
    fetch: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify({ ok: true, item_allocations: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await client.createProject({
    id: "p 1",
    name: "旅行",
    project_type: "split",
    currency: "JPY",
    created_at: T1,
    finalized_at: null,
  });
  await client.createProjectMember({
    id: "m1",
    project_id: "p 1",
    display_name: "A",
    role: "member",
    is_active: 1,
    created_at: T1,
  });
  await client.updateMemberHouseholdLink("m1", "home");
  await client.createTransaction({
    id: "t1",
    project_id: "p 1",
    merchant_name: "市場",
    gross_amount: 100,
    paid_amount: 100,
    occurred_at: T1,
    created_at: T1,
  });
  await client.createTransactionPayment({
    id: "pay1",
    transaction_id: "t1",
    payer_member_id: "m1",
    amount: 100,
    payment_method: "cash",
    occurred_at: T1,
    updated_at: T1,
  });
  await client.createTransactionItem({
    id: "item1",
    transaction_id: "t1",
    name: "合計",
    amount: 100,
    item_type: "summary",
    sort_order: 0,
    updated_at: T1,
  });
  await client.replaceItemAllocations("item1", [
    { id: "allocation1", transaction_item_id: "item1", project_member_id: "m1", allocated_amount: 100, created_at: T1 },
  ]);
  await client.listImports("p 1", { status: ["review", "error"], source_type: ["receipt", "card_csv"] });
  await client.createReceiptImport("p 1", { id: "import1", source_type: "receipt", merchant_raw: "市場", paid_amount_raw: 100 });
  await client.createCsvImports("p 1", "日付,金額\n2026-07-01,100", "card", { maxRows: 10 });
  await client.reconcileImport("import1", "link", { transaction_id: "t1" });
  await client.getProjectSummaries("p 1");
  await client.finalizeProject("p 1");
  await client.reopenProject("p 1");
  await client.createProjectShare("p 1", { role: "viewer" });
  await client.getSharedProject("token/value");
  assert.deepEqual(
    calls.map((call) => [call.options.method, call.url]),
    [
      ["POST", "/api/projects"],
      ["POST", "/api/projects/p%201/members"],
      ["PATCH", "/api/project-members/m1/household-link"],
      ["POST", "/api/projects/p%201/transactions"],
      ["POST", "/api/transactions/t1/payments"],
      ["POST", "/api/transactions/t1/items"],
      ["PUT", "/api/transaction-items/item1/allocations"],
      ["GET", "/api/projects/p%201/imports?status=review%2Cerror&source_type=receipt%2Ccard_csv"],
      ["POST", "/api/projects/p%201/imports/receipt"],
      ["POST", "/api/projects/p%201/imports/csv"],
      ["POST", "/api/imports/import1/reconcile"],
      ["GET", "/api/projects/p%201/summaries"],
      ["POST", "/api/projects/p%201/finalize"],
      ["POST", "/api/projects/p%201/reopen"],
      ["POST", "/api/projects/p%201/share"],
      ["GET", "/api/share/token%2Fvalue"],
    ],
  );
  assert.deepEqual(calls[0].body, { id: "p 1", name: "旅行", project_type: "split", currency: "JPY" });
  assert.deepEqual(calls[6].body, {
    allocations: [{ id: "allocation1", project_member_id: "m1", allocated_amount: 100 }],
  });
  assert.deepEqual(calls[8].body, { id: "import1", merchant_raw: "市場", paid_amount_raw: 100 });
  assert.deepEqual(calls[9].body, {
    csv: "日付,金額\n2026-07-01,100",
    profile: "card",
    options: { maxRows: 10 },
  });
});

test("APIのJSONエラーに状態番号と識別子を保持する", async () => {
  const client = WariApi.createApiClient({
    fetch: async () => new Response(JSON.stringify({ error: "project_finalized", field: "project_id" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    () => client.getProject("p1"),
    (error) => error instanceof WariApi.ApiError
      && error.status === 409
      && error.code === "project_finalized"
      && error.data.field === "project_id",
  );
});

test("Gmail接続前に画面の個人家計簿と同じ識別子でクラウド家計簿を作成する", async () => {
  const calls = [];
  let listCount = 0;
  const client = WariApi.createApiClient({
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (url === "/api/projects" && options.method === "GET") {
        listCount += 1;
        return Response.json({ projects: listCount === 1 ? [] : [{ id: "home", project_type: "household", access_role: "owner" }] });
      }
      if (url === "/api/projects") return Response.json({ projects: [{ id: "home" }] }, { status: 201 });
      return Response.json({ url: "https://accounts.google.com/gmail-oauth" });
    },
  });
  const result = await client.startGmailConnectionForProject({ id: "home", name: "生活費", project_type: "household", currency: "JPY" });
  assert.equal(result.url, "https://accounts.google.com/gmail-oauth");
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", "/api/projects"],
    ["POST", "/api/projects"],
    ["GET", "/api/projects"],
    ["POST", "/api/gmail/oauth/start"],
  ]);
  assert.deepEqual(calls[1].body, { id: "home", name: "生活費", project_type: "household", currency: "JPY" });
  assert.deepEqual(calls[3].body, { project_id: "home" });
});

test("作成済みの個人家計簿では重複作成せずGmail接続を開始する", async () => {
  const calls = [];
  const client = WariApi.createApiClient({
    fetch: async (url, options) => {
      calls.push([options.method, url]);
      if (url === "/api/projects") return Response.json({ projects: [{ id: "home", project_type: "household", access_role: "owner" }] });
      return Response.json({ url: "https://accounts.google.com/gmail-oauth" });
    },
  });
  await client.startGmailConnectionForProject({ id: "home", name: "生活費", project_type: "household" });
  assert.deepEqual(calls, [["GET", "/api/projects"], ["POST", "/api/gmail/oauth/start"]]);
});

test("個人家計簿の作成競合後に再読込してGmail接続を続行する", async () => {
  let listCount = 0;
  const calls = [];
  const client = WariApi.createApiClient({
    fetch: async (url, options) => {
      calls.push([options.method, url]);
      if (url === "/api/projects" && options.method === "GET") {
        listCount += 1;
        return Response.json({ projects: listCount === 1 ? [] : [{ id: "home", project_type: "household", access_role: "owner" }] });
      }
      if (url === "/api/projects") return Response.json({ error: "id_conflict" }, { status: 409 });
      return Response.json({ url: "https://accounts.google.com/gmail-oauth" });
    },
  });
  await client.startGmailConnectionForProject({ id: "home", name: "生活費", project_type: "household" });
  assert.deepEqual(calls, [
    ["GET", "/api/projects"],
    ["POST", "/api/projects"],
    ["GET", "/api/projects"],
    ["POST", "/api/gmail/oauth/start"],
  ]);
});

test("個人家計簿の作成競合後に所有者でなければGmail接続を拒否する", async () => {
  let listCount = 0;
  const calls = [];
  const client = WariApi.createApiClient({
    fetch: async (url, options) => {
      calls.push([options.method, url]);
      if (url === "/api/projects" && options.method === "GET") {
        listCount += 1;
        return Response.json({ projects: listCount === 1 ? [] : [{ id: "home", project_type: "household", access_role: "editor" }] });
      }
      return Response.json({ error: "id_conflict" }, { status: 409 });
    },
  });
  await assert.rejects(
    () => client.startGmailConnectionForProject({ id: "home", name: "生活費", project_type: "household" }),
    (error) => error.code === "gmail_shared_household_not_allowed",
  );
  assert.deepEqual(calls, [
    ["GET", "/api/projects"],
    ["POST", "/api/projects"],
    ["GET", "/api/projects"],
  ]);
});

test("Gmail接続準備の認証失効、共有家計簿、作成失敗を日本語で示す", async () => {
  const expired = WariApi.createApiClient({
    fetch: async () => Response.json({ error: "authentication_required" }, { status: 401 }),
  });
  await assert.rejects(
    () => expired.startGmailConnectionForProject({ id: "home", project_type: "household" }),
    (error) => error.code === "gmail_authentication_required" && /ログインし直してください/.test(error.message),
  );

  const shared = WariApi.createApiClient({
    fetch: async () => Response.json({ projects: [{ id: "home", project_type: "household", access_role: "editor" }] }),
  });
  await assert.rejects(
    () => shared.startGmailConnectionForProject({ id: "home", project_type: "household" }),
    (error) => error.code === "gmail_shared_household_not_allowed" && /共有家計簿/.test(error.message),
  );

  const ownerUnknown = WariApi.createApiClient({
    fetch: async () => Response.json({ projects: [{ id: "home", project_type: "household" }] }),
  });
  await assert.rejects(
    () => ownerUnknown.startGmailConnectionForProject({ id: "home", project_type: "household" }),
    (error) => error.code === "gmail_shared_household_not_allowed" && /共有家計簿/.test(error.message),
  );

  let requestCount = 0;
  const failed = WariApi.createApiClient({
    fetch: async () => {
      requestCount += 1;
      return requestCount === 1
        ? Response.json({ projects: [] })
        : Response.json({ error: "server_error" }, { status: 500 });
    },
  });
  await assert.rejects(
    () => failed.startGmailConnectionForProject({ id: "home", project_type: "household" }),
    (error) => /作成できませんでした/.test(error.message),
  );

  let conflictCount = 0;
  const nonIdConflict = WariApi.createApiClient({
    fetch: async () => {
      conflictCount += 1;
      return conflictCount === 1
        ? Response.json({ projects: [] })
        : Response.json({ error: "project_state_conflict" }, { status: 409 });
    },
  });
  await assert.rejects(
    () => nonIdConflict.startGmailConnectionForProject({ id: "home", project_type: "household" }),
    (error) => error.code === "project_state_conflict" && /作成できませんでした/.test(error.message),
  );

  const sharedAtStart = WariApi.createApiClient({
    fetch: async (url) => url === "/api/projects"
      ? Response.json({ projects: [{ id: "home", project_type: "household", access_role: "owner" }] })
      : Response.json({ error: "gmail_personal_household_required" }, { status: 403 }),
  });
  await assert.rejects(
    () => sharedAtStart.startGmailConnectionForProject({ id: "home", project_type: "household" }),
    (error) => error.code === "gmail_personal_household_required" && /共有中の家計簿/.test(error.message),
  );

  const oauthStartFailure = WariApi.createApiClient({
    fetch: async (url) => url === "/api/projects"
      ? Response.json({ projects: [{ id: "home", project_type: "household", access_role: "owner" }] })
      : Response.json({ error: "server_error" }, { status: 500 }),
  });
  await assert.rejects(
    () => oauthStartFailure.startGmailConnectionForProject({ id: "home", project_type: "household" }),
    (error) => error.code === "server_error" && /Gmail接続を開始できませんでした/.test(error.message),
  );
});

test("household row mutation sends the client owner in the project creation request", async () => {
  const calls=[];const client=WariApi.createApiClient({fetch:async(url,options)=>{calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});return Response.json({projects:[{id:"home"}],project_members:[{id:"device-owner",role:"owner"}]},{status:201});}});
  await client.mutateRow({action:"create",table:"projects",row:{id:"home",name:"Home",project_type:"household",currency:"JPY"},initialMember:{id:"device-owner",display_name:"Device owner",role:"owner",project_id:"home"}});
  assert.deepEqual(calls,[{url:"/api/projects",method:"POST",body:{id:"home",name:"Home",project_type:"household",currency:"JPY",initial_member:{id:"device-owner",display_name:"Device owner"}}}]);
});
