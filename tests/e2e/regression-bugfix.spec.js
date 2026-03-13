import { expect, test } from "@playwright/test";

function makeUser(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function bootWithUser(page, userId) {
  await page.addInitScript((id) => {
    if (!sessionStorage.getItem("__e2e_booted_bugfix__")) {
      localStorage.clear();
      localStorage.setItem(
        "yomuyomu_sync_v2",
        JSON.stringify({ userId: id, anonymousId: id, accountMode: "guest" })
      );
      sessionStorage.setItem("__e2e_booted_bugfix__", "1");
    }
  }, userId);
  await page.goto("/");
  await expect(page.locator("#chapterTitle")).toContainText("第一章 春の駅");
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
  await expect(page.locator("#bookTitle")).toContainText(expectedTitle, { timeout: 15_000 });
}

async function waitForApiOnline(page) {
  await expect
    .poll(async () => (((await page.locator("#apiStatus").textContent()) || "").replace(/\s+/g, "")), {
      timeout: 15_000,
    })
    .toContain("API在线");
}

async function selectTextInReader(page, needle) {
  const selected = await page.evaluate((targetText) => {
    const paragraphs = Array.from(document.querySelectorAll(".reader-para"));
    const paragraph = paragraphs.find((para) => {
      const content = Array.from(para.querySelectorAll(".jp-char"))
        .map((el) => el.textContent || "")
        .join("");
      return content.includes(targetText);
    });
    if (!paragraph) return false;

    const chars = Array.from(paragraph.querySelectorAll(".jp-char"));
    const content = chars.map((el) => el.textContent || "").join("");
    const start = content.indexOf(targetText);
    if (start < 0) return false;

    const end = start + targetText.length - 1;
    const range = document.createRange();
    range.setStart(chars[start].firstChild || chars[start], 0);
    range.setEnd(chars[end].firstChild || chars[end], 1);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return true;
  }, needle);
  expect(selected).toBeTruthy();
}

async function clickWordInReader(page, needle, charOffset = 0) {
  const clicked = await page.evaluate(({ targetText, offset }) => {
    const paragraphs = Array.from(document.querySelectorAll(".reader-para"));
    const paragraph = paragraphs.find((para) => {
      const content = Array.from(para.querySelectorAll(".jp-char"))
        .map((el) => el.textContent || "")
        .join("");
      return content.includes(targetText);
    });
    if (!paragraph) return false;

    const chars = Array.from(paragraph.querySelectorAll(".jp-char"));
    const content = chars.map((el) => el.textContent || "").join("");
    const start = content.indexOf(targetText);
    if (start < 0 || !chars[start]) return false;

    const targetIndex = Math.max(start, Math.min(start + targetText.length - 1, start + Number(offset || 0)));
    chars[targetIndex].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, { targetText: needle, offset: charOffset });
  expect(clicked).toBeTruthy();
}

test("layout keeps left sidebar separated and reader scrolls inside viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootWithUser(page, makeUser("layout"));
  await waitForApiOnline(page);

  const beforeDocHeight = await page.evaluate(() => document.scrollingElement?.scrollHeight || 0);
  const longChapterTitle = `第一章_${"VeryLongChapterTitleWithoutAnySpacesOrBreakPoints_".repeat(8)}`;
  const secondChapterTitle = `第二章_${"X".repeat(160)}`;
  const longText = Array.from(
    { length: 220 },
    (_, idx) => `第${idx + 1}段 改札を出ると春の風が吹き、静かな駅前に雨の匂いが残っていた。`
  ).join("\n");
  const longLine = `https://example.com/${"a".repeat(420)}`;
  await importTextBook(
    page,
    "long-scroll.txt",
    `${longChapterTitle}\n${longText}\n${longLine}\n\n${secondChapterTitle}\n${longText.slice(0, 1800)}`
  );
  await expect(page.locator("#chapterList .tiny-btn")).toHaveCount(2);

  const metrics = await page.evaluate((baseline) => {
    const left = document.querySelector(".left-panel")?.getBoundingClientRect();
    const reader = document.querySelector(".reader-panel")?.getBoundingClientRect();
    const viewport = document.getElementById("readerViewport");
    const leftPanel = document.querySelector(".left-panel");
    const readerContent = document.getElementById("readerContent");
    const docHeight = document.scrollingElement?.scrollHeight || 0;
    return {
      overlapPx: left && reader ? left.right - reader.left : 999,
      viewportClient: viewport?.clientHeight || 0,
      viewportScroll: viewport?.scrollHeight || 0,
      panelClient: document.querySelector(".reader-panel")?.clientHeight || 0,
      panelScroll: document.querySelector(".reader-panel")?.scrollHeight || 0,
      leftOverflowPx: Math.max(0, (leftPanel?.scrollWidth || 0) - (leftPanel?.clientWidth || 0)),
      readerOverflowPx: Math.max(
        0,
        (readerContent?.scrollWidth || 0) - (readerContent?.clientWidth || 0)
      ),
      docHeightDelta: Math.abs(docHeight - baseline),
    };
  }, beforeDocHeight);

  expect(metrics.overlapPx).toBeLessThanOrEqual(0);
  expect(metrics.leftOverflowPx).toBeLessThanOrEqual(1);
  expect(metrics.readerOverflowPx).toBeLessThanOrEqual(1);
  expect(metrics.viewportScroll).toBeGreaterThan(metrics.viewportClient * 2);
  expect(metrics.panelScroll - metrics.panelClient).toBeLessThan(6);
  expect(metrics.docHeightDelta).toBeLessThan(900);
});

test("imported book selection hits local dictionary and returns matched word form", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootWithUser(page, makeUser("dict-local"));
  await waitForApiOnline(page);

  await importTextBook(
    page,
    "dict-local-hit.txt",
    "第一章 点词\nホームで待った。改札を出た。\n\n第二章 次章\n春の駅前は静かだった。"
  );
  await expect(page.locator("#chapterList .tiny-btn")).toHaveCount(2);

  await selectTextInReader(page, "ホームで");
  await expect(page.locator("#selectedWord")).toHaveText("ホーム");
  await expect(page.locator("#selectedLemma")).toContainText("ホーム");
  await expect(page.getByTestId("word-meaning")).toContainText("站台");
  await expect(page.getByTestId("word-meaning")).not.toContainText("本地词库未命中");
  await expect(page.getByTestId("word-meaning")).not.toContainText("未加载 jmdict.db");
});

test("imported book click lookup uses the real local dictionary DB", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootWithUser(page, makeUser("dict-click-real"));
  await waitForApiOnline(page);

  await importTextBook(
    page,
    "dict-click-real.txt",
    "第一章 点词\n曖昧な表現を避ける。ホームで待った。"
  );

  await clickWordInReader(page, "表現を", 0);
  await expect(page.locator("#selectedWord")).toHaveText("表現");
  await expect(page.locator("#selectedLemma")).toContainText("表現");
  await expect(page.getByTestId("word-meaning")).not.toContainText("未加载 jmdict.db");
  await expect(page.getByTestId("word-meaning")).not.toContainText("本地词库未命中");
  await expect(page.getByTestId("word-meaning")).not.toContainText("点击查看释义");
});

test("imported book hard word overview keeps difficult words and drops glued easy forms in real runtime", async ({ page }) => {
  await bootWithUser(page, makeUser("hard-real-runtime"));
  await waitForApiOnline(page);

  await importTextBook(
    page,
    "hard-real-runtime.txt",
    "第一章 難词\n俺の語彙を磨く。曖昧な表現を避ける。改札を出る。昨日は駅へ行く。\n\n第二章 次章\n平気な顔で原則を語る。"
  );

  await expect
    .poll(async () => ((await page.locator("#hardWordList").textContent()) || "").trim(), {
      timeout: 30_000,
    })
    .not.toContain("正在分析难词...");
  await expect(page.locator("#hardWordList")).not.toContainText("该章节暂无高难词");

  const terms = (await page.locator("#hardWordList .hardword-item strong").allTextContents())
    .map((item) => item.trim())
    .filter(Boolean);

  expect(terms).toContain("語彙");
  expect(terms).toContain("曖昧");
  expect(terms).not.toContain("俺の");
  expect(terms).not.toContain("改札を");
  expect(terms).not.toContain("曖昧な");
  expect(terms).not.toContain("昨日");
});

test("paged mode next/prev stays in chapter and turns pages reliably", async ({ page }) => {
  await bootWithUser(page, makeUser("paged"));
  const chapterOneBody = Array.from(
    { length: 180 },
    (_, idx) => `第${idx + 1}行 改札を出ると春の風が吹き、僕は古い本屋に寄って文庫本を一冊買った。`
  ).join("\n");
  const chapterTwoBody = Array.from(
    { length: 40 },
    (_, idx) => `次章第${idx + 1}行 雨の窓には街の光がにじんで見えた。`
  ).join("\n");
  await importTextBook(
    page,
    "paged-regression.txt",
    `第一章 长页\n${chapterOneBody}\n\n第二章 次章\n${chapterTwoBody}`
  );

  await page.getByRole("button", { name: "分页" }).click();
  await expect(page.locator("#pagedControls")).toBeVisible();
  await expect(page.locator("#chapterTitle")).toContainText("第一章 长页");

  const chapterBefore = ((await page.locator("#chapterTitle").textContent()) || "").trim();
  const topBefore = await page.locator("#readerViewport").evaluate((el) => el.scrollTop);

  await page.locator("#nextPageBtn").click();
  await page.waitForTimeout(420);

  const chapterAfterNext = ((await page.locator("#chapterTitle").textContent()) || "").trim();
  const topAfterNext = await page.locator("#readerViewport").evaluate((el) => el.scrollTop);
  expect(chapterAfterNext).toBe(chapterBefore);
  expect(topAfterNext).toBeGreaterThan(topBefore + 20);

  await page.locator("#prevPageBtn").click();
  await page.waitForTimeout(420);

  const chapterAfterPrev = ((await page.locator("#chapterTitle").textContent()) || "").trim();
  const topAfterPrev = await page.locator("#readerViewport").evaluate((el) => el.scrollTop);
  expect(chapterAfterPrev).toBe(chapterBefore);
  expect(topAfterPrev).toBeLessThan(topAfterNext);
});

test("guest clicking subscribe pro opens account flow instead of silent no-op", async ({ page }) => {
  await bootWithUser(page, makeUser("billing"));
  await page.getByRole("tab", { name: "更多" }).click();
  await page.locator('[data-more-section="plan"] > summary').click();
  await expect(page.locator("#upgradeProBtn")).toBeEnabled();

  await page.locator("#upgradeProBtn").click();
  await expect(page.locator("#accountModal")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText("请先注册或登录账号");
});

test("faq keeps 6-8 items with key topics", async ({ page }) => {
  await bootWithUser(page, makeUser("faq"));
  const faqItems = page.locator(".faq-item");
  const count = await faqItems.count();
  expect(count).toBeGreaterThanOrEqual(6);
  expect(count).toBeLessThanOrEqual(8);

  await expect(page.locator("#faq")).toContainText("导入");
  await expect(page.locator("#faq")).toContainText("订阅");
  await expect(page.locator("#faq")).toContainText("隐私");
  await expect(page.locator("#faq")).toContainText("同步");
  await expect(page.locator("#faq")).toContainText("词典");
});
