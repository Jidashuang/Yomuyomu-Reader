import { expect, test } from "@playwright/test";

function makeUser(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function bootWithUser(page, userId) {
  await page.addInitScript((id) => {
    if (!sessionStorage.getItem("__e2e_booted_reader_analysis__")) {
      localStorage.clear();
      localStorage.setItem(
        "yomuyomu_sync_v2",
        JSON.stringify({ userId: id, anonymousId: id, accountMode: "guest" })
      );
      sessionStorage.setItem("__e2e_booted_reader_analysis__", "1");
    }
  }, userId);
  await page.goto("/");
  await expect(page.locator("#chapterTitle")).not.toContainText("阅读区");
}

async function waitForApiOnline(page) {
  await expect
    .poll(async () => (((await page.locator("#apiStatus").textContent()) || "").replace(/\s+/g, "")), {
      timeout: 15_000,
    })
    .toContain("API在线");
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
  await expect(page.locator("#bookTitle")).toContainText(expectedTitle, { timeout: 20_000 });
}

function buildDirtyAnalysisTokens(paragraph, surfaces, paragraphIndex = 0) {
  let cursor = 0;
  return surfaces.map((surface) => {
    const start = paragraph.indexOf(surface, cursor);
    if (start < 0) {
      throw new Error(`Unable to place dirty token "${surface}" inside paragraph "${paragraph}"`);
    }
    const end = start + surface.length;
    cursor = end;
    return {
      paragraphIndex,
      surface,
      lemma: surface,
      dictionaryForm: surface,
      reading: "",
      pos: "fallback",
      start,
      end,
      jlpt: "",
    };
  });
}

async function mockImportedBook(page, book) {
  const jobId = `job-${book.id}`;
  await page.route("**/api/books/import", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, jobId }),
    });
  });
  await page.route(`**/api/import-jobs/${jobId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        job: {
          jobId,
          status: "completed",
          bookId: book.id,
        },
      }),
    });
  });
  await page.route(new RegExp(`/api/books/${book.id}(\\?.*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, book }),
    });
  });
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

async function readStoredVocab(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("yomuyomu_vocab_v2") || "[]");
    } catch {
      return [];
    }
  });
}

test("imported book click lookup normalizes noun, inflected verb, and katakana hits", async ({ page }) => {
  const lookupPayloads = [];
  await page.route("**/api/dict/lookup", async (route) => {
    lookupPayloads.push(JSON.parse(route.request().postData() || "{}"));
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  const paragraph = "ホームで待った。改札を出た。俺の語彙を磨く。";
  await mockImportedBook(page, {
    id: "dirty-import-click-book",
    title: "dict-real-chain",
    format: "txt",
    chapters: [
      {
        id: "dirty-import-click-ch-1",
        title: "第一章 点词链路",
        text: paragraph,
        paragraphs: [paragraph],
        analysis: {
          chapterId: "dirty-import-click-ch-1",
          tokens: buildDirtyAnalysisTokens(
            paragraph,
            ["ホームで", "待った", "。", "改札を", "出た", "。", "俺の", "語彙を", "磨く", "。"],
            0
          ),
          difficultVocab: [],
        },
      },
    ],
  });

  await bootWithUser(page, makeUser("dict-real"));
  await waitForApiOnline(page);
  await importTextBook(
    page,
    "dict-real-chain.txt",
    `第一章 点词链路\n${paragraph}`,
    "dict-real-chain"
  );

  lookupPayloads.length = 0;
  await clickWordInReader(page, "改札を", 0);
  await expect(page.locator("#selectedWord")).toHaveText("改札");
  await expect(page.locator("#selectedLemma")).toContainText("改札");
  await expect(page.getByTestId("word-meaning")).toContainText("检票口");
  expect(lookupPayloads.some((item) => item?.surface === "改札" || item?.lemma === "改札")).toBeTruthy();
  await page.locator("#addWordBtn").click();
  let vocab = await readStoredVocab(page);
  let latest = vocab[vocab.length - 1] || {};
  expect(latest.word).toBe("改札");
  expect(latest.lemma).toBe("改札");

  lookupPayloads.length = 0;
  await clickWordInReader(page, "待った", 0);
  await expect(page.locator("#selectedWord")).toHaveText("待つ");
  await expect(page.locator("#selectedLemma")).toContainText("待つ");
  await expect(page.getByTestId("word-meaning")).toContainText("等待");
  expect(lookupPayloads.some((item) => item?.surface === "待つ" || item?.lemma === "待つ")).toBeTruthy();
  await page.locator("#addWordBtn").click();
  vocab = await readStoredVocab(page);
  latest = vocab[vocab.length - 1] || {};
  expect(latest.word).toBe("待つ");
  expect(latest.lemma).toBe("待つ");

  lookupPayloads.length = 0;
  await clickWordInReader(page, "ホームで", 0);
  await expect(page.locator("#selectedWord")).toHaveText("ホーム");
  await expect(page.locator("#selectedLemma")).toContainText("ホーム");
  await expect(page.getByTestId("word-meaning")).toContainText("站台");
  expect(lookupPayloads.some((item) => item?.surface === "ホーム" || item?.lemma === "ホーム")).toBeTruthy();
});

test("hard word overview keeps difficult lexemes and excludes simple or attached-particle items", async ({ page }) => {
  const chapterOneParagraph = "俺の語彙を磨く。曖昧な表現を避ける。改札を出る。昨日は駅へ行く。";
  const chapterTwoParagraph = "平気な顔で原則を語る。";
  await mockImportedBook(page, {
    id: "dirty-import-hard-book",
    title: "hard-overview-real",
    format: "txt",
    chapters: [
      {
        id: "dirty-import-hard-ch-1",
        title: "第一章 難词",
        text: chapterOneParagraph,
        paragraphs: [chapterOneParagraph],
        analysis: {
          chapterId: "dirty-import-hard-ch-1",
          tokens: buildDirtyAnalysisTokens(
            chapterOneParagraph,
            ["俺の", "語彙を", "磨く", "。", "曖昧な", "表現を", "避ける", "。", "改札を", "出る", "。", "昨日は", "駅へ", "行く", "。"],
            0
          ),
          difficultVocab: [
            { word: "俺の", lemma: "俺の", level: "N2", count: 1, meaning: "错误粘连词" },
            { word: "語彙を", lemma: "語彙を", level: "N1", count: 1, meaning: "错误粘连词" },
            { word: "曖昧な", lemma: "曖昧な", level: "N1", count: 1, meaning: "错误粘连词" },
            { word: "改札を", lemma: "改札を", level: "N2", count: 1, meaning: "错误粘连词" },
            { word: "昨日", lemma: "昨日", level: "N3", count: 1, meaning: "简单词" },
          ],
        },
      },
      {
        id: "dirty-import-hard-ch-2",
        title: "第二章 次章",
        text: chapterTwoParagraph,
        paragraphs: [chapterTwoParagraph],
        analysis: {
          chapterId: "dirty-import-hard-ch-2",
          tokens: buildDirtyAnalysisTokens(
            chapterTwoParagraph,
            ["平気な", "顔で", "原則を", "語る", "。"],
            0
          ),
          difficultVocab: [{ word: "原則を", lemma: "原則を", level: "N1", count: 1, meaning: "错误粘连词" }],
        },
      },
    ],
  });

  await bootWithUser(page, makeUser("hard-real"));
  await waitForApiOnline(page);
  await importTextBook(
    page,
    "hard-overview-real.txt",
    `第一章 難词\n${chapterOneParagraph}\n\n第二章 次章\n${chapterTwoParagraph}`,
    "hard-overview-real"
  );

  await expect
    .poll(async () => ((await page.locator("#hardWordList").textContent()) || "").trim(), {
      timeout: 30_000,
    })
    .not.toContain("正在分析难词...");
  await expect(page.locator("#hardWordList")).not.toContainText("该章节暂无高难词");
  await expect
    .poll(
      async () =>
        (await page.locator("#hardWordList .hardword-item strong").allTextContents())
          .map((item) => item.trim())
          .filter(Boolean)
          .join("|"),
      { timeout: 20_000 }
    )
    .toContain("語彙");

  const terms = (await page.locator("#hardWordList .hardword-item strong").allTextContents())
    .map((item) => item.trim())
    .filter(Boolean);

  expect(terms).toContain("語彙");
  expect(terms).toContain("曖昧");
  expect(terms).not.toContain("昨日");
  expect(terms).not.toContain("俺の");
  expect(terms).not.toContain("改札を");
  expect(terms).not.toContain("語彙を");
  expect(terms).not.toContain("曖昧な");
});

test("book frequency stats show totals and non-empty high-frequency word list", async ({ page }) => {
  const paragraph = "現地の原則を確認する。現地で原則を守る。現地の見地を学ぶ。";
  await mockImportedBook(page, {
    id: "dirty-import-freq-book",
    title: "freq-real-chain",
    format: "txt",
    chapters: [
      {
        id: "dirty-import-freq-ch-1",
        title: "第一章 统计",
        text: paragraph,
        paragraphs: [paragraph],
        analysis: {
          chapterId: "dirty-import-freq-ch-1",
          tokens: buildDirtyAnalysisTokens(
            paragraph,
            ["現地の", "原則を", "確認する", "。", "現地で", "原則を", "守る", "。", "現地の", "見地を", "学ぶ", "。"],
            0
          ),
          difficultVocab: [],
        },
      },
    ],
  });

  await bootWithUser(page, makeUser("freq-real"));
  await waitForApiOnline(page);
  await importTextBook(
    page,
    "freq-real-chain.txt",
    `第一章 统计\n${paragraph}`,
    "freq-real-chain"
  );

  await expect
    .poll(async () => ((await page.locator("#freqSummary").textContent()) || "").trim(), {
      timeout: 30_000,
    })
    .not.toContain("正在统计词频...");
  await expect(page.locator("#freqSummary")).toContainText("总词数");
  await expect(page.locator("#freqList")).not.toContainText("暂无高频词");

  const firstItemWord = await page.locator("#freqList .hardword-main strong").first().textContent();
  const firstItemCount = await page.locator("#freqList .meta").first().textContent();
  expect((firstItemWord || "").trim().length).toBeGreaterThan(0);
  expect((firstItemCount || "").trim()).toMatch(/出现\s*\d+\s*次/);
});
