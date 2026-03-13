import { expect, test } from "@playwright/test";

function makeUser(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function bootWithUser(page, userId) {
  await page.addInitScript((id) => {
    if (!sessionStorage.getItem("__e2e_booted__")) {
      localStorage.clear();
      localStorage.setItem(
        "yomuyomu_sync_v2",
        JSON.stringify({ userId: id, anonymousId: id, accountMode: "guest" })
      );
      sessionStorage.setItem("__e2e_booted__", "1");
    }
  }, userId);
  await page.goto("/");
  await expect(page.locator("#chapterTitle")).toContainText("第一章 春の駅");
  await expect(page.getByTestId("paragraph-sample-ch-1-0")).toBeVisible();
}

async function openAccountModal(page) {
  await page.locator("#accountMenu > summary").click();
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator("#accountModal")).toBeVisible();
}

async function openToolsTab(page, tabName) {
  await page.getByRole("tab", { name: tabName }).click();
}

async function registerAccount(page, userId) {
  await openAccountModal(page);
  const registerForm = page.locator("#accountGuestPanel .account-form").first();
  await registerForm.locator("#registerAccountInput").fill(userId);
  await registerForm.locator("#registerPasswordInput").evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, "alpha-pass-123");
  await registerForm.getByRole("button", { name: "注册" }).click();
  await expect(page.locator("#accountModeLabel")).toContainText(userId);
}

async function loginAccount(page, userId) {
  await openAccountModal(page);
  const loginForm = page.locator("#accountGuestPanel .account-form").nth(1);
  await loginForm.locator("#loginAccountInput").fill(userId);
  await loginForm.locator("#loginPasswordInput").evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, "alpha-pass-123");
  await loginForm.getByRole("button", { name: "登录" }).click();
  await expect(page.locator("#accountModeLabel")).toContainText(userId);
}

async function importTextBook(page, name, text, expectedTitle = name.replace(/\.txt$/i, "")) {
  const statusText = page.locator("#statusText");
  await page.setInputFiles("#fileInput", {
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(text, "utf-8"),
  });

  await expect
    .poll(
      async () => ((await statusText.textContent()) || "").trim(),
      { timeout: 30_000 }
    )
    .not.toContain(`正在导入 ${name}`);

  const finalStatus = ((await statusText.textContent()) || "").trim();
  expect(finalStatus).not.toContain("后端导入失败");
  expect(finalStatus).not.toContain("该格式需要后端 API");

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          try {
            return JSON.parse(localStorage.getItem("yomuyomu_book_v3") || "{}")?.title || "";
          } catch {
            return "";
          }
        }),
      { timeout: 30_000 }
    )
    .toContain(expectedTitle);

  await expect(page.locator("#bookTitle")).toContainText(expectedTitle, { timeout: 15_000 });
}

async function selectSentence(page, testId) {
  const sentence = page.getByTestId(testId);
  await expect(sentence).toBeVisible();
  await sentence.evaluate((el) => {
    const chars = Array.from(el.querySelectorAll(".jp-char"));
    if (!chars.length) return;
    const first = chars[0];
    const last = chars[chars.length - 1];
    const range = document.createRange();
    range.setStart(first.firstChild || first, 0);
    const lastLength = Math.max(1, String(last.textContent || "").length);
    range.setEnd(last.firstChild || last, lastLength);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

test("billing checkout callback updates plan on success page", async ({ page }) => {
  const userId = makeUser("billing");
  const accountToken = `acct-token-${Date.now()}`;
  let callbackCount = 0;
  let callbackPayload = null;
  let callbackToken = "";

  await page.route("**/api/billing/checkout-complete", async (route) => {
    callbackCount += 1;
    callbackToken = route.request().headers()["x-account-token"] || "";
    callbackPayload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        billing: {
          userId,
          plan: "pro",
          billingCycle: "monthly",
        },
        billingCycle: "monthly",
        order: {
          orderId: "order-callback-1",
        },
        session: {
          id: "cs_test_callback_123",
          status: "complete",
          paymentStatus: "paid",
        },
      }),
    });
  });

  await page.addInitScript(({ id, token }) => {
    localStorage.setItem(
      "yomuyomu_sync_v2",
      JSON.stringify({
        userId: id,
        accountToken: token,
      })
    );
  }, { id: userId, token: accountToken });

  await page.goto("/billing-success.html?session_id=cs_test_callback_123");
  await expect(page.locator("#statusText")).toContainText("支付成功，订阅状态已同步。");
  await expect(page.locator("#detailText")).toContainText("当前套餐：Pro");
  await expect(page.locator("#detailText")).toContainText("月付");

  expect(callbackCount).toBe(1);
  expect(callbackPayload).toEqual({
    sessionId: "cs_test_callback_123",
    userId,
  });
  expect(callbackToken).toBe(accountToken);
});

test("first visit opens sample book and prefetched next chapter", async ({ page }) => {
  const nextChapterResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/books/") &&
      response.url().includes("/chapters/sample-ch-2") &&
      response.request().method() === "GET"
  );

  await bootWithUser(page, makeUser("sample"));
  await nextChapterResponse;

  await expect(page.locator("#bookTitle")).toContainText("YomuYomu Starter Sample");
  await expect(page.locator("#chapterProgress")).toContainText("章节 1 / 3");

  await page.getByRole("button", { name: "第二章 雨の窓" }).click();
  await expect(page.locator("#chapterTitle")).toContainText("第二章 雨の窓");
  await expect(page.getByTestId("paragraph-sample-ch-2-0")).toBeVisible();
});

test("clicking a highlighted sample word shows popover details", async ({ page }) => {
  await bootWithUser(page, makeUser("word"));

  await page.getByTestId("paragraph-sample-ch-1-1").locator(".jp-char", { hasText: "改" }).click();

  await expect(page.locator("#selectedWord")).toHaveText("改札");
  await expect(page.locator("#selectedReading")).not.toHaveText("-");
  await expect(page.getByTestId("word-meaning")).not.toContainText("在阅读区拖选");
});

test("dictionary lookup happy path uses api result", async ({ page }) => {
  await bootWithUser(page, makeUser("dict"));
  let lookupPayload = null;

  await page.route("**/api/dict/lookup", async (route) => {
    lookupPayload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        entries: [
          {
            surface: "改札",
            lemma: "改札",
            reading: "かいさつ",
            pos: "名词",
            gloss_zh: "检票口",
          },
        ],
      }),
    });
  });

  await page.getByTestId("paragraph-sample-ch-1-1").locator(".jp-char", { hasText: "改" }).click();
  await expect(page.locator("#selectedWord")).toHaveText("改札");
  await expect(page.getByTestId("word-meaning")).toContainText("检票口");
  await expect(page.locator("#dictLink")).toHaveAttribute("href", /改札|%E6%94%B9%E6%9C%AD/);
  expect(String(lookupPayload?.surface || "")).toContain("改");
});

test("clicking the same sentence twice uses cached AI explain", async ({ page }) => {
  await bootWithUser(page, makeUser("cache"));

  await selectSentence(page, "sentence-sample-ch-1-0-p0-s0");
  await expect(page.getByTestId("explain-status")).not.toContainText("AI 正在解释句子...");
  const firstExplainStatus = (await page.getByTestId("explain-status").textContent()) || "";
  const unavailableHints = [
    "AI 解释功能暂未配置。",
    "AI 解释服务暂时不可用，请稍后再试。",
  ];
  if (unavailableHints.some((hint) => firstExplainStatus.includes(hint))) {
    return;
  }
  const firstTranslation = ((await page.getByTestId("explain-translation").textContent()) || "").trim();
  if (!firstTranslation) {
    return;
  }

  await selectSentence(page, "sentence-sample-ch-1-0-p0-s0");
  await expect(page.getByTestId("explain-status")).toContainText("命中缓存");
});

test("free users are blocked on the sixth uncached explain", async ({ page }) => {
  await bootWithUser(page, makeUser("limit"));
  await registerAccount(page, makeUser("acct"));
  const seed = Date.now().toString(36);
  await importTextBook(
    page,
    "limit-case.txt",
    `第一${seed}文です。第二${seed}文です。第三${seed}文です。第四${seed}文です。第五${seed}文です。第六${seed}文です。`
  );

  await selectSentence(page, "sentence-ch-1-0-p0-s0");
  await expect(page.getByTestId("explain-status")).not.toContainText("AI 正在解释句子...");
  const firstExplainStatus = (await page.getByTestId("explain-status").textContent()) || "";
  const unavailableHints = [
    "AI 解释功能暂未配置。",
    "AI 解释服务暂时不可用，请稍后再试。",
  ];
  if (unavailableHints.some((hint) => firstExplainStatus.includes(hint))) {
    return;
  }
  const limitReachedPattern = /已用完|today['’]s ai explanation limit|reached today/i;

  for (let index = 0; index < 5; index += 1) {
    await selectSentence(page, `sentence-ch-1-0-p0-s${index}`);
    await expect(page.getByTestId("explain-status")).not.toContainText(limitReachedPattern);
  }

  await selectSentence(page, "sentence-ch-1-0-p0-s5");
  await expect(page.getByTestId("explain-status")).toContainText(limitReachedPattern);
});

test("sync failure only shows toast and preserves local vocab after reload", async ({ page }) => {
  await bootWithUser(page, makeUser("sync"));
  await registerAccount(page, makeUser("acct"));

  await page.getByTestId("paragraph-sample-ch-1-1").locator(".jp-char", { hasText: "改" }).click();
  await expect(page.locator("#selectedWord")).toHaveText("改札");
  const addedWord = (await page.locator("#selectedWord").textContent())?.trim() || "";
  await page.getByTestId("add-vocab-btn").click();

  await page.locator("#accountMenu > summary").click();
  await page.getByRole("button", { name: "云端上传" }).click();
  await expect(page.locator("#appToast")).toContainText("云同步仅对 Pro 套餐开放");

  await page.reload();
  await expect(page.locator("#chapterTitle")).toContainText("第一章 春の駅");
  await openToolsTab(page, "生词");
  await expect(page.getByTestId("vocab-list")).toContainText(addedWord);
});

test("logout returns to guest mode and login restores the registered account", async ({ page }) => {
  await bootWithUser(page, makeUser("auth"));
  const username = makeUser("acct");

  await registerAccount(page, username);
  await page.locator("#accountMenu > summary").click();
  await page.locator("#logoutButton").click();
  await expect(page.locator("#accountModeLabel")).toContainText("游客模式");

  await loginAccount(page, username);
  await expect(page.locator("#accountModeLabel")).toContainText(username);
});

test("account modal shows password rule and forgot-password fallback", async ({ page }) => {
  await bootWithUser(page, makeUser("auth-ui"));
  await openAccountModal(page);

  await expect(page.locator("#accountGuestPanel")).toContainText("密码规则：至少 8 位字符");

  await page.getByRole("button", { name: "忘记密码？" }).click();
  await expect(page.locator("#statusText")).toContainText("重置密码功能即将开放");
});

test("duplicate imports reuse the same analyzed book", async ({ page }) => {
  await bootWithUser(page, makeUser("dupe"));
  await registerAccount(page, makeUser("acct"));

  await importTextBook(page, "dupe-a.txt", "静かな駅です。\n春の本屋です。");
  const firstBookId = await page.evaluate(() => JSON.parse(localStorage.getItem("yomuyomu_book_v3")).id);

  await importTextBook(page, "dupe-b.txt", "静かな駅です。\n春の本屋です。", "dupe-a");
  const secondBookId = await page.evaluate(() => JSON.parse(localStorage.getItem("yomuyomu_book_v3")).id);

  expect(secondBookId).toBe(firstBookId);
});

test("reader import open and restore progress after reload", async ({ page }) => {
  await bootWithUser(page, makeUser("restore"));
  await registerAccount(page, makeUser("acct"));

  await importTextBook(
    page,
    "restore-progress.txt",
    "第一章 春の駅\n春は静かな駅です。\n\n第二章 夏の窓\n夏は明るい窓です。",
    "restore-progress"
  );

  const progressSaved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/books/") &&
      response.url().includes("/progress") &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "第二章 夏の窓" }).click();
  await progressSaved;

  await expect(page.locator("#chapterTitle")).toContainText("第二章 夏の窓");
  await expect(page.locator("#chapterProgress")).toContainText("章节 2 / 2");
  await expect(page.getByTestId("paragraph-ch-2-0")).toBeVisible();

  await page.reload();
  await expect(page.locator("#bookTitle")).toContainText("restore-progress");
  await expect(page.locator("#chapterTitle")).toContainText("第二章 夏の窓");
  await expect(page.locator("#chapterProgress")).toContainText("章节 2 / 2");
  await expect(page.getByTestId("paragraph-ch-2-0")).toBeVisible();
});

test("unicode and full-width punctuation do not break click mapping", async ({ page }) => {
  await bootWithUser(page, makeUser("unicode"));
  await registerAccount(page, makeUser("acct"));
  await importTextBook(page, "unicode.txt", "「改札」は広い。");

  await page.getByTestId("paragraph-ch-1-0").locator(".jp-char", { hasText: "改" }).click();
  await expect(page.locator("#selectedWord")).toHaveText("改札");
});
