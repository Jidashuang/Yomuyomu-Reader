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

async function clickSentence(page, testId, charIndex = 0) {
  const sentence = page.getByTestId(testId);
  await expect(sentence).toBeVisible();
  const chars = sentence.locator(".jp-char");
  const count = await chars.count();
  const targetIndex = charIndex >= 0 ? charIndex : Math.max(0, count + charIndex);
  await chars.nth(targetIndex).click();
}

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

test("clicking the same sentence twice uses cached AI explain", async ({ page }) => {
  await bootWithUser(page, makeUser("cache"));

  await clickSentence(page, "sentence-sample-ch-1-0-p0-s0", 0);
  await expect(page.getByTestId("explain-translation")).not.toHaveText("");

  await clickSentence(page, "sentence-sample-ch-1-0-p0-s0", 0);
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

  await clickSentence(page, "sentence-ch-1-0-p0-s0", -1);
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
    await clickSentence(page, `sentence-ch-1-0-p0-s${index}`, -1);
    await expect(page.getByTestId("explain-status")).not.toContainText(limitReachedPattern);
  }

  await clickSentence(page, "sentence-ch-1-0-p0-s5", -1);
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

test("unicode and full-width punctuation do not break click mapping", async ({ page }) => {
  await bootWithUser(page, makeUser("unicode"));
  await registerAccount(page, makeUser("acct"));
  await importTextBook(page, "unicode.txt", "「改札」は広い。");

  await page.getByTestId("paragraph-ch-1-0").locator(".jp-char", { hasText: "改" }).click();
  await expect(page.locator("#selectedWord")).toHaveText("改札");
});
