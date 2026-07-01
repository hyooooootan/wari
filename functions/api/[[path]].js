const emptyData = {
  projects: [],
  members: [],
  expenses: [],
  expense_payments: [],
  items: [],
  item_members: [],
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  try {
    if (request.method === "POST" && path[0] === "ocr-receipt") {
      return handleReceiptOcr(request, env);
    }

    if (!env.DB) return json({ error: "missing_d1_binding" }, 500);

    if (request.method === "GET" && path[0] === "projects" && path.length === 1) {
      return json(await listProjects(env.DB));
    }

    if (request.method === "POST" && path[0] === "projects" && path.length === 1) {
      const data = await request.json();
      await saveProjectGraph(env.DB, normalizeGraph(data));
      return json({ ok: true });
    }

    if (path[0] === "projects" && path[1]) {
      const projectId = path[1];
      if (request.method === "GET" && path.length === 2) {
        const graph = await getProjectGraph(env.DB, projectId);
        if (!graph.projects.length) return json({ error: "not_found" }, 404);
        return json(graph);
      }
      if (request.method === "PUT" && path.length === 2) {
        const data = await request.json();
        const graph = normalizeGraph(data);
        if (!graph.projects.some((p) => p.id === projectId)) return json({ error: "project_id_mismatch" }, 400);
        await saveProjectGraph(env.DB, graph);
        return json({ ok: true });
      }
      if (request.method === "DELETE" && path.length === 2) {
        await deleteProject(env.DB, projectId);
        return json({ ok: true });
      }
      if (request.method === "POST" && path[2] === "share") {
        const share = await createShare(env.DB, projectId);
        return json(share);
      }
    }

    if (request.method === "GET" && path[0] === "share" && path[1]) {
      const share = await getShare(env.DB, path[1]);
      if (!share) return json({ error: "not_found" }, 404);
      const graph = await getProjectGraph(env.DB, share.project_id);
      return json({ ...graph, share });
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    return json({ error: "server_error", message: String(error?.message || error) }, 500);
  }
}

async function listProjects(db) {
  const { results } = await db
    .prepare(
      `SELECT
        p.id,
        p.name,
        p.created_at,
        (SELECT COUNT(*) FROM members WHERE project_id = p.id) AS member_count,
        (SELECT COUNT(*) FROM expenses WHERE project_id = p.id) AS expense_count,
        COALESCE((SELECT SUM(total_amount) FROM expenses WHERE project_id = p.id), 0) AS total_amount
      FROM projects p
      ORDER BY p.created_at DESC`
    )
    .all();
  return { projects: results || [] };
}

async function getProjectGraph(db, projectId) {
  const data = structuredClone(emptyData);
  data.projects = (await db.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).all()).results || [];
  data.members = (await db.prepare("SELECT * FROM members WHERE project_id = ? ORDER BY created_at").bind(projectId).all()).results || [];
  data.expenses = (await db.prepare("SELECT * FROM expenses WHERE project_id = ? ORDER BY paid_at, created_at").bind(projectId).all()).results || [];
  data.expense_payments = (await db.prepare("SELECT * FROM expense_payments WHERE project_id = ? ORDER BY created_at").bind(projectId).all()).results || [];
  data.items = (await db.prepare("SELECT * FROM items WHERE project_id = ? ORDER BY created_at").bind(projectId).all()).results || [];
  data.item_members = (await db.prepare("SELECT * FROM item_members WHERE project_id = ? ORDER BY created_at").bind(projectId).all()).results || [];
  return data;
}

async function saveProjectGraph(db, data) {
  const project = data.projects[0];
  if (!project?.id || !project?.name) throw new Error("project is required");
  const projectId = project.id;
  const statements = [
    db
      .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name")
      .bind(project.id, project.name, project.created_at),
    db.prepare("DELETE FROM item_members WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM items WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM expense_payments WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM expenses WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM members WHERE project_id = ?").bind(projectId),
  ];

  for (const m of data.members) {
    statements.push(db.prepare("INSERT INTO members (id, project_id, name, created_at) VALUES (?, ?, ?, ?)").bind(m.id, projectId, m.name, m.created_at));
  }
  for (const e of data.expenses) {
    statements.push(
      db
        .prepare("INSERT INTO expenses (id, project_id, payer_member_id, store_name, total_amount, paid_at, receipt_image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(e.id, projectId, e.payer_member_id || null, e.store_name, Number(e.total_amount || 0), e.paid_at, e.receipt_image_url || null, e.created_at)
    );
  }
  for (const p of data.expense_payments) {
    statements.push(
      db
        .prepare("INSERT INTO expense_payments (id, project_id, expense_id, member_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(p.id, projectId, p.expense_id, p.member_id, Number(p.amount || 0), p.created_at)
    );
  }
  for (const i of data.items) {
    statements.push(db.prepare("INSERT INTO items (id, project_id, expense_id, name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(i.id, projectId, i.expense_id, i.name, Number(i.amount || 0), i.created_at));
  }
  for (const link of data.item_members) {
    statements.push(db.prepare("INSERT INTO item_members (id, project_id, item_id, member_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(link.id, projectId, link.item_id, link.member_id, link.created_at));
  }

  await db.batch(statements);
}

async function deleteProject(db, projectId) {
  await db.batch([
    db.prepare("DELETE FROM project_shares WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM item_members WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM items WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM expense_payments WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM expenses WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM members WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
  ]);
}

async function createShare(db, projectId) {
  const existing = await db.prepare("SELECT * FROM project_shares WHERE project_id = ? LIMIT 1").bind(projectId).first();
  if (existing) return existing;
  const share = {
    id: makeId("shr"),
    project_id: projectId,
    token: makeToken(),
    role: "editor",
    expires_at: null,
    created_at: new Date().toISOString(),
  };
  await db
    .prepare("INSERT INTO project_shares (id, project_id, token, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(share.id, share.project_id, share.token, share.role, share.expires_at, share.created_at)
    .run();
  return share;
}

async function getShare(db, token) {
  return db.prepare("SELECT * FROM project_shares WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)").bind(token, new Date().toISOString()).first();
}

function normalizeGraph(data) {
  const graph = { ...structuredClone(emptyData), ...data };
  for (const key of Object.keys(emptyData)) {
    if (!Array.isArray(graph[key])) graph[key] = [];
  }
  const projectId = graph.projects[0]?.id;
  if (!projectId) throw new Error("project id is required");
  graph.projects = graph.projects.slice(0, 1).map((p) => ({ id: String(p.id), name: String(p.name || "割り勘"), created_at: p.created_at || new Date().toISOString() }));
  graph.members = graph.members.filter((x) => x.project_id === projectId).map((x) => ({ id: String(x.id), project_id: projectId, name: String(x.name || "名前なし"), created_at: x.created_at || new Date().toISOString() }));
  graph.expenses = graph.expenses
    .filter((x) => x.project_id === projectId)
    .map((x) => ({ id: String(x.id), project_id: projectId, payer_member_id: x.payer_member_id || null, store_name: String(x.store_name || "お店"), total_amount: Number(x.total_amount || 0), paid_at: x.paid_at || new Date().toISOString().slice(0, 10), receipt_image_url: x.receipt_image_url || null, created_at: x.created_at || new Date().toISOString() }));
  graph.expense_payments = graph.expense_payments
    .filter((x) => x.project_id === projectId)
    .map((x) => ({ id: String(x.id), project_id: projectId, expense_id: String(x.expense_id), member_id: String(x.member_id), amount: Number(x.amount || 0), created_at: x.created_at || new Date().toISOString() }));
  graph.items = graph.items.filter((x) => x.project_id === projectId).map((x) => ({ id: String(x.id), project_id: projectId, expense_id: String(x.expense_id), name: String(x.name || "品目"), amount: Number(x.amount || 0), created_at: x.created_at || new Date().toISOString() }));
  graph.item_members = graph.item_members.filter((x) => x.project_id === projectId).map((x) => ({ id: String(x.id), project_id: projectId, item_id: String(x.item_id), member_id: String(x.member_id), created_at: x.created_at || new Date().toISOString() }));
  return graph;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

async function handleReceiptOcr(request, env) {
  const payload = await request.json().catch(() => ({}));
  const imageDataUrl = payload.image_data_url;
  if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    return json({ error: "invalid_image", message: "画像ファイルを選択してください。" }, 400);
  }

  const backend = String(env.OCR_BACKEND || "auto").toLowerCase();
  if (backend === "openai") return readReceiptWithOpenAI(imageDataUrl, env);
  if (backend === "gemini") return readReceiptWithGemini(imageDataUrl, env);
  if (backend === "auto") {
    if (env.OPENAI_API_KEY) return readReceiptWithOpenAI(imageDataUrl, env);
    if (env.GEMINI_API_KEY) return readReceiptWithGemini(imageDataUrl, env);
    return json({ error: "missing_api_key", message: "OPENAI_API_KEY または GEMINI_API_KEY を Cloudflare Pages の環境変数に設定してください。" }, 503);
  }
  return json({ error: "unsupported_ocr_backend", message: "Cloudflareでは OCR_BACKEND に auto、openai、gemini を指定してください。" }, 400);
}

async function readReceiptWithOpenAI(imageDataUrl, env) {
  if (!env.OPENAI_API_KEY) {
    return json({ error: "missing_api_key", message: "OPENAI_API_KEY が未設定です。Cloudflare Pages の環境変数に設定してください。" }, 503);
  }
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      store_name: { type: ["string", "null"], description: "レシートの店名。読めない場合はnull。" },
      total_amount: { type: ["integer", "null"], description: "税込の最終支払金額。円単位。読めない場合はnull。" },
      paid_at: { type: ["string", "null"], description: "支払日。YYYY-MM-DD形式。読めない場合はnull。" },
      confidence: { type: "number", description: "0から1の推定信頼度。" },
      notes: { type: "string", description: "読み取り時の注意点。なければ空文字。" },
    },
    required: ["store_name", "total_amount", "paid_at", "confidence", "notes"],
  };
  const openaiRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_OCR_MODEL || "gpt-5.4-mini",
      store: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: receiptOcrPrompt(),
            },
            { type: "input_image", image_url: imageDataUrl, detail: "high" },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "receipt_ocr",
          schema,
          strict: true,
        },
      },
    }),
  });
  const data = await openaiRes.json().catch(() => ({}));
  if (!openaiRes.ok) return json({ error: "openai_error", message: JSON.stringify(data).slice(0, 1000) }, 502);
  const outputText = data.output_text || data.output?.flatMap((x) => x.content || []).find((x) => x.type === "output_text")?.text;
  if (!outputText) return json({ error: "empty_ocr_result", message: "読み取り結果が空でした。" }, 502);
  return json({ ...JSON.parse(outputText), model: data.model || env.OPENAI_OCR_MODEL || "gpt-5.4-mini" });
}

async function readReceiptWithGemini(imageDataUrl, env) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: "missing_api_key", message: "GEMINI_API_KEY が未設定です。Cloudflare Pages の環境変数に設定してください。" }, 503);
  }
  const image = splitImageDataUrl(imageDataUrl);
  const model = env.GEMINI_OCR_MODEL || "gemini-2.5-flash";
  const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: receiptOcrPrompt() },
            { inlineData: { mimeType: image.mimeType, data: image.base64Data } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: geminiReceiptSchema(),
      },
    }),
  });
  const data = await geminiRes.json().catch(() => ({}));
  if (!geminiRes.ok) return json({ error: "gemini_error", message: JSON.stringify(data).slice(0, 1000) }, 502);
  const outputText = data.candidates?.flatMap((x) => x.content?.parts || []).find((x) => x.text)?.text;
  if (!outputText) return json({ error: "empty_ocr_result", message: "読み取り結果が空でした。" }, 502);
  return json({ ...JSON.parse(outputText), model });
}

function receiptOcrPrompt() {
  return (
    "日本のレシート画像から、店名、税込の最終支払金額、支払日を読み取ってください。" +
    "合計、総合計、現計、クレジット支払額、電子マネー支払額など最終的に支払った金額を優先してください。" +
    "預り金、釣銭、ポイント、税額、小計をtotal_amountにしないでください。"
  );
}

function geminiReceiptSchema() {
  return {
    type: "object",
    properties: {
      store_name: { type: "string", nullable: true, description: "レシートの店名。読めない場合はnull。" },
      total_amount: { type: "integer", nullable: true, description: "税込の最終支払金額。円単位。読めない場合はnull。" },
      paid_at: { type: "string", nullable: true, description: "支払日。YYYY-MM-DD形式。読めない場合はnull。" },
      confidence: { type: "number", description: "0から1の推定信頼度。" },
      notes: { type: "string", description: "読み取り時の注意点。なければ空文字。" },
    },
    required: ["store_name", "total_amount", "paid_at", "confidence", "notes"],
  };
}

function splitImageDataUrl(imageDataUrl) {
  const [header, base64Data] = imageDataUrl.split(",", 2);
  if (!header || !base64Data || !header.includes(";base64")) throw new Error("画像データの形式が不正です。");
  const mimeType = header.replace(/^data:/, "").split(";")[0] || "image/jpeg";
  return { mimeType, base64Data };
}

function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
