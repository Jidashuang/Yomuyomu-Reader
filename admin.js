const els = {
  tokenInput: document.getElementById("adminTokenInput"),
  refreshBtn: document.getElementById("adminRefreshBtn"),
  status: document.getElementById("adminStatus"),
  tableBody: document.getElementById("adminUsersTableBody"),
};

function appendCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.appendChild(cell);
}

function renderUsers(users) {
  els.tableBody.textContent = "";
  users.forEach((user) => {
    const row = document.createElement("tr");
    appendCell(row, String(user.userId || "-"));
    appendCell(row, String(user.username || "-"));
    appendCell(row, String(user.createdAt || "-"));
    els.tableBody.appendChild(row);
  });
}

async function fetchUsers() {
  const token = String(els.tokenInput.value || "").trim();
  const response = await fetch("/api/admin/users", {
    headers: token ? { "X-Admin-Token": token } : {},
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return Array.isArray(payload.users) ? payload.users : [];
}

async function refreshUsers() {
  els.status.textContent = "加载中...";
  try {
    const users = await fetchUsers();
    renderUsers(users);
    els.status.textContent = `已加载 ${users.length} 个用户。`;
  } catch (error) {
    els.status.textContent = `加载失败：${error.message}`;
  }
}

els.refreshBtn?.addEventListener("click", () => {
  void refreshUsers();
});

void refreshUsers();
