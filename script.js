const loginForm = document.querySelector("#login-form");
const logoutButton = document.querySelector("#logout-button");
const uploadForm = document.querySelector("#upload-form");
const uploadFileInput = document.querySelector("#upload-file");
const uploadPreviewCard = document.querySelector("#upload-preview-card");
const passwordForm = document.querySelector("#password-form");
const documentForm = document.querySelector("#document-form");
const questionForm = document.querySelector("#question-form");
const saveStatus = document.querySelector("#save-status");
const loginStatus = document.querySelector("#login-status");
const documentList = document.querySelector("#document-list");
const answerCard = document.querySelector("#answer-card");
const documentCount = document.querySelector("#document-count");
const documentPanel = document.querySelector("#document-panel");
const sessionCard = document.querySelector("#session-card");
const sessionName = document.querySelector("#session-name");
const sessionRole = document.querySelector("#session-role");

let currentSession = null;
let pendingImportDraft = null;

loginForm.addEventListener("submit", handleLoginSubmit);
logoutButton.addEventListener("click", handleLogout);
uploadForm.addEventListener("submit", handleUploadSubmit);
passwordForm.addEventListener("submit", handlePasswordSubmit);
documentForm.addEventListener("submit", handleDocumentSubmit);
questionForm.addEventListener("submit", handleQuestionSubmit);

await bootstrap();

async function bootstrap() {
  await refreshSession();
  await loadDocuments();
}

async function refreshSession() {
  try {
    const response = await fetch("/api/session");
    const payload = await response.json();
    currentSession = payload.session ?? null;
    renderSession();
  } catch {
    currentSession = null;
    renderSession();
  }
}

function renderSession() {
  const isAdmin = currentSession?.role === "admin";
  const isLoggedIn = Boolean(currentSession);

  documentPanel.classList.toggle("hidden", !isAdmin);
  sessionCard.classList.toggle("hidden", !isLoggedIn);
  loginForm.classList.toggle("hidden", isLoggedIn);

  if (!isLoggedIn) {
    sessionName.textContent = "未登录";
    sessionRole.textContent = "请先登录";
    resetUploadPreview();
    return;
  }

  sessionName.textContent = currentSession.displayName || currentSession.username;
  sessionRole.textContent = isAdmin ? "角色：管理员，可入库、删除、改密码和提问" : "角色：普通用户，只能提问";
}

async function loadDocuments() {
  try {
    const response = await fetch("/api/documents");
    const payload = await response.json();
    renderDocuments(payload.documents ?? []);
  } catch {
    saveStatus.textContent = "加载知识库失败，请确认服务已经启动。";
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  const formData = new FormData(loginForm);
  const payload = {
    username: String(formData.get("username") ?? "").trim(),
    password: String(formData.get("password") ?? "").trim(),
  };

  loginStatus.textContent = "正在登录...";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? "登录失败");
    }

    currentSession = result.session;
    loginForm.reset();
    loginStatus.textContent = "";
    renderSession();
  } catch (error) {
    loginStatus.textContent = error.message || "登录失败，请稍后重试。";
  }
}

async function handleLogout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } finally {
    currentSession = null;
    pendingImportDraft = null;
    renderSession();
    loginStatus.textContent = "";
    saveStatus.textContent = "";
    answerCard.classList.add("empty");
    answerCard.innerHTML = "<p>这里会显示基于知识库生成的结论、依据和建议。</p>";
  }
}

async function handleUploadSubmit(event) {
  event.preventDefault();

  const file = uploadFileInput.files?.[0];
  if (!file) {
    saveStatus.textContent = "请先选择要上传的文件。";
    return;
  }

  saveStatus.textContent = `正在解析：${file.name}`;

  try {
    const contentBase64 = await readFileAsBase64(file);
    const formData = new FormData(uploadForm);
    const payload = {
      filename: file.name,
      title: String(formData.get("title") ?? "").trim(),
      category: String(formData.get("category") ?? "").trim(),
      contentBase64,
    };

    const response = await fetch("/api/documents/import-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? "生成预览失败");
    }

    pendingImportDraft = result.draft;
    renderUploadPreview(result.draft);
    saveStatus.textContent = `已生成预览：《${result.draft.title}》`;
  } catch (error) {
    saveStatus.textContent = error.message || "上传失败，请稍后重试。";
  }
}

async function handleConfirmImport() {
  if (!pendingImportDraft) {
    return;
  }

  saveStatus.textContent = `正在正式入库：《${pendingImportDraft.title}》`;

  try {
    const response = await fetch("/api/documents/import-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId: pendingImportDraft.draftId }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? "确认入库失败");
    }

    saveStatus.textContent = `文件已入库：《${result.document.title}》`;
    uploadForm.reset();
    resetUploadPreview();
    await loadDocuments();
  } catch (error) {
    saveStatus.textContent = error.message || "确认入库失败，请稍后重试。";
  }
}

function handleCancelImport() {
  pendingImportDraft = null;
  resetUploadPreview();
  saveStatus.textContent = "已取消本次导入预览。";
}

async function handlePasswordSubmit(event) {
  event.preventDefault();
  const formData = new FormData(passwordForm);
  const payload = {
    currentPassword: String(formData.get("currentPassword") ?? "").trim(),
    nextPassword: String(formData.get("nextPassword") ?? "").trim(),
  };

  saveStatus.textContent = "正在修改密码...";

  try {
    const response = await fetch("/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? "修改密码失败");
    }

    passwordForm.reset();
    saveStatus.textContent = "密码已更新，请妥善保管新密码。";
  } catch (error) {
    saveStatus.textContent = error.message || "修改密码失败，请稍后重试。";
  }
}

async function handleDocumentSubmit(event) {
  event.preventDefault();

  const formData = new FormData(documentForm);
  const payload = {
    title: String(formData.get("title") ?? "").trim(),
    category: String(formData.get("category") ?? "").trim(),
    content: String(formData.get("content") ?? "").trim(),
  };

  saveStatus.textContent = "正在保存制度内容...";

  try {
    const response = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? "保存失败");
    }

    documentForm.reset();
    saveStatus.textContent = `已保存：《${result.document.title}》`;
    await loadDocuments();
  } catch (error) {
    saveStatus.textContent = error.message || "保存失败，请稍后重试。";
  }
}

async function handleDeleteDocument(documentId, documentTitle) {
  if (!currentSession || currentSession.role !== "admin") {
    return;
  }

  const confirmed = window.confirm(`确认删除《${documentTitle}》吗？删除后不会自动恢复。`);
  if (!confirmed) {
    return;
  }

  saveStatus.textContent = `正在删除：《${documentTitle}》`;

  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? "删除失败");
    }

    saveStatus.textContent = `已删除：《${documentTitle}》`;
    await loadDocuments();
  } catch (error) {
    saveStatus.textContent = error.message || "删除失败，请稍后重试。";
  }
}

async function handleQuestionSubmit(event) {
  event.preventDefault();

  const formData = new FormData(questionForm);
  const question = String(formData.get("question") ?? "").trim();

  answerCard.classList.remove("empty");
  answerCard.innerHTML = "<p>正在检索知识库并生成答案...</p>";

  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? "查询失败");
    }

    renderAnswer(result.answer);
  } catch (error) {
    answerCard.innerHTML = `<p>${escapeHtml(error.message || "查询失败，请稍后再试。")}</p>`;
  }
}

function renderUploadPreview(draft) {
  uploadPreviewCard.classList.remove("hidden", "empty");
  uploadPreviewCard.innerHTML = `
    <h3>导入预览</h3>
    <p><strong>标题：</strong>${escapeHtml(draft.title || "未命名制度")}</p>
    <p><strong>分类：</strong>${escapeHtml(draft.category || "未设置")}</p>
    <p><strong>来源类型：</strong>${escapeHtml(draft.sourceType || "未知")}</p>
    <p><strong>正文长度：</strong>${draft.contentLength} 字符</p>
    <h4>正文预览</h4>
    <pre class="preview-text">${escapeHtml(draft.preview || "")}</pre>
    <div class="preview-actions">
      <button class="primary-button" type="button" id="confirm-import-button">确认入库</button>
      <button class="secondary-button" type="button" id="cancel-import-button">取消</button>
    </div>
  `;

  document.querySelector("#confirm-import-button")?.addEventListener("click", handleConfirmImport);
  document.querySelector("#cancel-import-button")?.addEventListener("click", handleCancelImport);
}

function resetUploadPreview() {
  pendingImportDraft = null;
  uploadPreviewCard.classList.add("hidden", "empty");
  uploadPreviewCard.innerHTML = "<p>上传后会先显示正文预览，你确认没问题再入库。</p>";
}

function renderDocuments(documents) {
  documentCount.textContent = String(documents.length);

  if (documents.length === 0) {
    documentList.innerHTML = '<p class="empty-hint">还没有制度内容，先录入一份试试。</p>';
    return;
  }

  documentList.innerHTML = documents
    .map((document) => {
      const category = document.category ? `分类：${escapeHtml(document.category)}` : "分类：未设置";
      const snippet = escapeHtml(document.preview ?? "");
      const createdAt = document.createdAt ? ` · 入库时间：${escapeHtml(formatDate(document.createdAt))}` : "";
      const actions = currentSession?.role === "admin"
        ? `<button class="danger-button" type="button" data-action="delete-document" data-id="${escapeHtml(document.id)}" data-title="${escapeHtml(document.title)}">删除</button>`
        : "";

      return `
        <article class="document-item">
          <div class="document-topline">
            <h3>${escapeHtml(document.title)}</h3>
            ${actions}
          </div>
          <p class="document-meta">${category} · 共 ${document.chunkCount} 个知识片段${createdAt}</p>
          <p class="document-snippet">${snippet}</p>
        </article>
      `;
    })
    .join("");

  bindDocumentActions();
}

function bindDocumentActions() {
  documentList.querySelectorAll('[data-action="delete-document"]').forEach((button) => {
    button.addEventListener("click", () => {
      handleDeleteDocument(button.dataset.id, button.dataset.title);
    });
  });
}

function renderAnswer(answer) {
  if (!answer) {
    answerCard.classList.add("empty");
    answerCard.innerHTML = "<p>没有可展示的答案。</p>";
    return;
  }

  const stepsItems = (answer.steps ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const violationItems = (answer.violationHandling ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  answerCard.innerHTML = `
    <h3>处理建议</h3>
    <p>${escapeHtml(answer.summary ?? "知识库中未找到明确依据。")}</p>
    <h4>建议这样做</h4>
    <p>${escapeHtml(answer.workGuide || "建议先核对制度依据，再按流程处理。")}</p>
    <h4>先做什么</h4>
    <ul>${stepsItems || "<li>建议先补充对应制度后再处理。</li>"}</ul>
    <h4>发现违规时怎么处理</h4>
    <ul>${violationItems || "<li>知识库中未找到明确的违规处理条款。</li>"}</ul>
  `;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const base64 = result.includes(",") ? result.split(",").pop() : result;
      resolve(base64 || "");
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
