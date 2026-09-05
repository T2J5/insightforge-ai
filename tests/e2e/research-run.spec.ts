import { expect, test, type Page } from "@playwright/test";

const RUN_ID = "00000000-0000-4000-8000-000000000011";
const CITATION_ID = "00000000-0000-4000-8000-000000000012";

const apiPath = (path: string): RegExp =>
  new RegExp(`https?://[^/]+${path.replaceAll("/", "\\/")}(?:\\?.*)?$`);

const completedRun = {
  runId: RUN_ID,
  company: "字节跳动",
  focus: "comprehensive",
  depth: "quick",
  status: "completed",
  tokenUsage: 1_240,
  estimatedCostCny: 0.86,
  createdAt: "2026-09-05T08:00:00.000Z",
  updatedAt: "2026-09-05T08:01:30.000Z",
};

const report = {
  reportId: RUN_ID,
  version: 1,
  content: {
    title: "字节跳动企业竞争力调研报告",
    executiveSummary: [
      {
        markdown: "字节跳动持续经营内容与企业服务业务。",
        claimType: "fact",
        citationIds: [CITATION_ID],
      },
    ],
    sections: [
      {
        key: "company_overview",
        heading: "公司概览",
        blocks: [
          {
            markdown: "公开资料显示，公司持续投入核心产品与技术。",
            claimType: "fact",
            citationIds: [CITATION_ID],
          },
        ],
      },
    ],
  },
  citations: [
    {
      id: CITATION_ID,
      sourceType: "web",
      sourceCategory: "official",
      sourceUrl: "https://www.bytedance.com/",
      sourceTitle: "ByteDance 官方网站",
      publisher: "ByteDance",
      publishedAt: null,
      quote: "字节跳动持续经营内容与企业服务业务。",
    },
  ],
  qualityWarning: null,
  publishedAt: "2026-09-05T08:01:30.000Z",
};

const installCompletedJourney = async (page: Page): Promise<void> => {
  await page.route(apiPath("/api/runs"), async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ runId: RUN_ID, status: "queued" }),
    });
  });
  await page.route(apiPath(`/api/runs/${RUN_ID}`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(completedRun),
    });
  });
  await page.route(apiPath(`/api/runs/${RUN_ID}/events`), async (route) => {
    const events = [
      {
        id: 1,
        runId: RUN_ID,
        type: "progress",
        status: "running",
        stage: "planning",
        message: "Agent 开始规划企业调研任务",
        progress: 10,
        occurredAt: "2026-09-05T08:00:05.000Z",
        data: {},
      },
      {
        id: 2,
        runId: RUN_ID,
        type: "status",
        status: "completed",
        stage: "completed",
        message: "企业调研报告已生成",
        progress: 100,
        occurredAt: "2026-09-05T08:01:30.000Z",
        data: {},
      },
    ];
    const body = events
      .map(
        (event) =>
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body,
    });
  });
  await page.route(apiPath(`/api/reports/${RUN_ID}`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(report),
    });
  });
};

test("游客创建快速调研并查看报告引用", async ({ page }) => {
  await installCompletedJourney(page);
  await page.goto("/");

  await page.getByLabel("公司名称").fill("字节跳动");
  await page.getByRole("button", { name: "开始快速调研" }).click();

  await expect(page.getByText("正在规划调研问题")).toBeVisible();
  await expect(page.getByText("企业调研报告已生成").first()).toBeVisible();
  await page.getByRole("link", { name: "阅读完整报告" }).click();

  await expect(
    page.getByRole("heading", { name: "字节跳动企业竞争力调研报告" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看引用 1" }).first().click();
  const sourceDialog = page.getByRole("dialog", { name: "来源原文" });
  await expect(sourceDialog).toBeVisible();
  await expect(sourceDialog.getByText(report.citations[0].quote)).toBeVisible();
});

test("刷新运行页后从服务端恢复已完成状态", async ({ page }) => {
  await installCompletedJourney(page);
  await page.goto(`/runs/${RUN_ID}`);
  await page.reload();

  await expect(page.getByText("企业调研报告已生成").first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "阅读完整报告" }),
  ).toHaveAttribute("href", `/reports/${RUN_ID}`);
});

test("用户可以取消仍在运行的调研", async ({ page }) => {
  await page.route(apiPath(`/api/runs/${RUN_ID}`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...completedRun, status: "running" }),
    });
  });
  await page.route(apiPath(`/api/runs/${RUN_ID}/events`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    });
  });
  await page.route(apiPath(`/api/runs/${RUN_ID}/cancel`), async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ runId: RUN_ID, status: "cancelled" }),
    });
  });

  await page.goto(`/runs/${RUN_ID}`);
  await page.getByRole("button", { name: "取消调研" }).click();
  await expect(page.getByRole("heading", { name: "调研已取消" })).toBeVisible();
});

test("首页在关键移动端宽度没有横向溢出", async ({ page }) => {
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${width}px viewport overflow`).toBeLessThanOrEqual(0);
  }
});
