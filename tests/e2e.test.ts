import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

const BASE_URL = "http://localhost:3333";
const EVIDENCE_DIR = "/Users/jaemin/.sisyphus/evidence";

const serverAvailable = await fetch(BASE_URL, {
  signal: AbortSignal.timeout(1000),
})
  .then(() => true)
  .catch(() => false);

if (!serverAvailable) {
  console.log(`[e2e] Server not running at ${BASE_URL} — skipping E2E tests`);
}

const describeE2E = serverAvailable ? describe : describe.skip;

describeE2E("OC Dashboard v3.1 E2E", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    await page.waitForFunction(
      () => document.getElementById("stat-active")?.textContent !== "—",
      { timeout: 10000 },
    );
  }, 30000);

  afterAll(async () => {
    await browser?.close();
  });

  test("1. Layout structure (summary-bar inside main-content)", async () => {
    const sidebar = page.locator(".sidebar");
    expect(await sidebar.count()).toBe(1);
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox!.width).toBeCloseTo(240, -1);

    const summaryBar = page.locator(".main-content .summary-bar");
    expect(await summaryBar.count()).toBe(1);

    expect(await page.locator(".main-content").count()).toBe(1);
    expect(await page.locator(".process-panel").count()).toBe(1);

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-layout.png`,
      fullPage: true,
    });
  });

  test("2. Sidebar project selection + filtering (v3.1: flat session list)", async () => {
    const sidebarItems = page.locator("#sidebar-list .sidebar-item");
    const itemCount = await sidebarItems.count();

    if (itemCount >= 2) {
      await sidebarItems.nth(1).click();
      await page.waitForTimeout(500);

      const mainHeaders = page.locator(".main-content .main-header");
      expect(await mainHeaders.count()).toBe(1);

      await sidebarItems.nth(0).click();
      await page.waitForTimeout(500);

      const allSessions = page.locator(".main-content .session-card");
      expect(await allSessions.count()).toBeGreaterThanOrEqual(1);
    } else {
      expect(itemCount).toBeGreaterThanOrEqual(1);
    }

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-sidebar-filter.png`,
      fullPage: true,
    });
  });

  test("3. Summary bar data display", async () => {
    await page.waitForSelector(".summary-bar .stat-card", { timeout: 5000 });
    const statCards = page.locator(".summary-bar .stat-card");
    expect(await statCards.count()).toBe(5);

    const firstValue = await statCards.nth(0).locator(".stat-value").textContent();
    expect(firstValue).not.toBeNull();
    expect(firstValue!.trim()).toMatch(/^\d+$/);

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-summary-bar.png`,
      fullPage: true,
    });
  });

  test("4. Agent label above title", async () => {
    const agentLabels = page.locator(".session-card .agent-label");
    const count = await agentLabels.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const text = await agentLabels.nth(i).textContent();
        expect(text!.trim().length).toBeGreaterThan(0);
        expect(text).not.toContain("⚡");
      }
    }

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-agent-label.png`,
      fullPage: true,
    });
  });

  test("5. Git diff display (null-safe)", async () => {
    const gitDiffs = page.locator(".git-diff");
    const count = await gitDiffs.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const text = await gitDiffs.nth(i).textContent();
        expect(text).toContain("+");
      }
    }

    const pageContent = await page.content();
    expect(pageContent).not.toContain("+0 -0 · 0 files");

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-git-diff.png`,
      fullPage: true,
    });
  });

  test("6. Sub-session badge (no emoji)", async () => {
    const badges = page.locator(".sub-agent-badge");
    const count = await badges.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const text = await badges.nth(i).textContent();
        expect(text!.toLowerCase()).toContain("sub-sessions");
        expect(text).not.toContain("0 active");
        expect(text).not.toContain("🤖");
      }
    }

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-sub-sessions.png`,
      fullPage: true,
    });
  });

  test("7. SSE update preserves sidebar selection", async () => {
    const sidebarItems = page.locator("#sidebar-list .sidebar-item");
    const itemCount = await sidebarItems.count();

    if (itemCount >= 2) {
      await sidebarItems.nth(1).click();
      await page.waitForTimeout(500);

      const isActive = await sidebarItems
        .nth(1)
        .evaluate((el) => el.classList.contains("active"));
      expect(isActive).toBe(true);

      await page.waitForTimeout(3000);

      const stillActive = await page
        .locator("#sidebar-list .sidebar-item.active")
        .first()
        .getAttribute("data-project-id");
      const selectedId = await sidebarItems
        .nth(1)
        .getAttribute("data-project-id");
      expect(stillActive).toBe(selectedId);
    } else {
      const allActive = await sidebarItems
        .nth(0)
        .evaluate((el) => el.classList.contains("active"));
      expect(allActive).toBe(true);
    }

    await sidebarItems.nth(0).click();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-selection-persist.png`,
      fullPage: true,
    });
  }, 15000);

  test("8. Notification banner exists", async () => {
    const banner = page.locator("#notif-banner");
    expect(await banner.count()).toBe(1);

    const exists = await banner.evaluate((el) => el instanceof HTMLElement);
    expect(exists).toBe(true);

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-notif-banner.png`,
      fullPage: true,
    });
  });

  test("9. Process panel rendering", async () => {
    const processPanel = page.locator(".process-panel");
    expect(await processPanel.count()).toBe(1);

    const sectionLabel = processPanel.locator(".section-label");
    expect(await sectionLabel.count()).toBe(1);
    const labelText = await sectionLabel.textContent();
    expect(labelText).toContain("Running Processes");

    await page.screenshot({
      path: `${EVIDENCE_DIR}/v3.1-process-panel.png`,
      fullPage: true,
    });
  });
});
