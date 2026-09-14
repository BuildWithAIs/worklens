import { expect, test } from "@playwright/test";

const widths = [390, 1024, 1280] as const;

for (const width of widths) {
  test(`首页在 ${width}px 宽度无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "让工作，从这里继续。",
    );
    const productImage = page.getByAltText(/WorkLens 桌面应用/);
    await expect(productImage).toBeVisible();
    await expect
      .poll(() =>
        productImage.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
}

test("导航锚点和 FAQ 可交互", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳转到正文" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);

  await page.getByRole("link", { name: "开始使用", exact: true }).click();
  await expect(page).toHaveURL(/#start$/);
  await expect(
    page.getByRole("heading", { name: /带上你的模型/ }),
  ).toBeVisible();

  const question = page.getByText("使用需要付费吗？", { exact: true });
  await question.click();
  await expect(
    page.getByText(/项目以 MIT 协议开放源码。模型服务需要你自行配置/),
  ).toBeVisible();
});

test("静态站不请求业务 API，未知路径返回 404", async ({ page, request }) => {
  const apiRequests: string[] = [];
  page.on("request", (entry) => {
    if (new URL(entry.url()).pathname.startsWith("/api/")) {
      apiRequests.push(entry.url());
    }
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(apiRequests).toEqual([]);

  const response = await request.get("/not-a-real-page");
  expect(response.status()).toBe(404);
  expect(await response.text()).toContain("这个页面不在这里。");
});
