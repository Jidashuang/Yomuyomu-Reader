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

async function registerAccount(page, userId) {
  await page.fill("#registerAccountInput", userId);
  await page.getByRole("button", { name: "注册账号" }).click();
  await expect(page.locator("#accountModeLabel")).toContainText(`账号：${userId}`);
}

async function importTextBook(page, name, text, expectedTitle = name.replace(/\.txt$/i, "")) {
  await page.setInputFiles("#fileInput", {
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(text, "utf-8"),
  });
  await expect(page.locator("#bookTitle")).toContainText(expectedTitle);
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

  for (let index = 0; index < 5; index += 1) {
    await clickSentence(page, `sentence-ch-1-0-p0-s${index}`, -1);
    await expect(page.getByTestId("explain-status")).not.toContainText("已用完");
  }

  await clickSentence(page, "sentence-ch-1-0-p0-s5", -1);
  await expect(page.getByTestId("explain-status")).toContainText("已用完");
});

test("sync failure only shows toast and preserves local vocab after reload", async ({ page }) => {
  await bootWithUser(page, makeUser("sync"));
  await registerAccount(page, makeUser("acct"));

  await page.getByTestId("paragraph-sample-ch-1-1").locator(".jp-char", { hasText: "改" }).click();
  await expect(page.locator("#selectedWord")).toHaveText("改札");
  const addedWord = (await page.locator("#selectedWord").textContent())?.trim() || "";
  await page.getByTestId("add-vocab-btn").click();

  await page.getByRole("button", { name: "云端上传" }).click();
  await expect(page.locator("#appToast")).toContainText("云同步仅对 Pro 套餐开放");

  await page.reload();
  await expect(page.locator("#chapterTitle")).toContainText("第一章 春の駅");
  await page.getByRole("tab", { name: "生词本" }).click();
  await expect(page.getByTestId("vocab-list")).toContainText(addedWord);
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
