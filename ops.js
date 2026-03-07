const els = {
  tokenInput: document.getElementById("opsTokenInput"),
  daysInput: document.getElementById("opsDaysInput"),
  refreshBtn: document.getElementById("opsRefreshBtn"),
  status: document.getElementById("opsStatus"),
  tableBody: document.getElementById("opsTableBody"),
};

function formatRate(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

async function fetchOpsRows() {
  const token = String(els.tokenInput.value || "").trim();
  const days = Math.max(1, Math.min(90, Number(els.daysInput.value || 14) || 14));
  const response = await fetch(`/api/admin/ops/daily?days=${days}`, {
    headers: token ? { "X-Admin-Token": token } : {},
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload.rows || [];
}

function renderRows(rows) {
  els.tableBody.textContent = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.day || "-"}</td>
      <td>${Number(row.sampleOpens || 0)}</td>
      <td>${Number(row.wordClicks || 0)}</td>
      <td>${Number(row.explainRequests || 0)}</td>
      <td>${formatRate(row.cacheHitRate)}</td>
      <td>${formatRate(row.importSuccessRate)}</td>
      <td>${Number(row.jobRequeues || 0)}</td>
      <td>${formatRate(row.syncFailureRate)}</td>
      <td>${Number(row.upgradeClicks || 0)}</td>
      <td>${Number(row.paidSuccesses || 0)}</td>
    `;
    els.tableBody.appendChild(tr);
  });
}

async function refresh() {
  els.status.textContent = "加载中...";
  try {
    const rows = await fetchOpsRows();
    renderRows(rows);
    els.status.textContent = `已加载 ${rows.length} 天数据。`;
  } catch (error) {
    els.status.textContent = `加载失败：${error.message}`;
  }
}

els.refreshBtn?.addEventListener("click", () => {
  void refresh();
});

void refresh();
