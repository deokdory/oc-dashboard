import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

const BASE_URL = "http://localhost:3333";
const EVIDENCE_DIR = "/Users/jaemin/.sisyphus/evidence";

describe("OC Dashboard v3 E2E", () => {
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
    await browser.close();
  });

  test("1. Layout structure", async () => {
    const sidebar = page.locator(".sidebar");
    expect(await sidebar.count()).toBe(1);
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox!.width).toBeCloseTo(240, -1);

    expect(await page.locator(".summary-panel").count()).toBe(1);
    expect(await page.locator(".main-content").count()).toBe(1);
    expect(await page.locator(".process-panel").count()).toBe(1);

    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-v3-10-layout.png`,
      fullPage: true,
    });
  });

  test("2. Sidebar project selection + filtering", async () => {
    const sidebarItems = page.locator("#sidebar-list .sidebar-item");
    const itemCount = await sidebarItems.count();

    if (itemCount >= 2) {
      await sidebarItems.nth(1).click();
      await page.waitForTimeout(500);

      const filteredCards = page.locator(".main-content .project-card");
      expect(await filteredCards.count()).toBe(1);

      await sidebarItems.nth(0).click();
      await page.waitForTimeout(500);

      const allCards = page.locator(".main-content .project-card");
      expect(await allCards.count()).toBeGreaterThanOrEqual(1);
    } else {
      expect(itemCount).toBeGreaterThanOrEqual(1);
    }

    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-v3-10-sidebar-filter.png`,
      fullPage: true,
    });
  });

  test("3. Summary panel data display", async () => {
    const statActive = await page.locator("#stat-active").textContent();
    const statTokenIn = await page.locator("#stat-token-in").textContent();
    const statTokenOut = await page.locator("#stat-token-out").textContent();

    expect(statActive).not.toBeNull();
    expect(statActive).not.toBe("—");
    expect(statActive).not.toBe("NaN");
    expect(statActive).not.toBe("undefined");
    expect(statActive!.trim()).toMatch(/^\d+$/);

    expect(statTokenIn).not.toBeNull();
    expect(statTokenIn).not.toBe("—");
    expect(statTokenIn).not.toBe("NaN");
    expect(statTokenIn!.trim()).toMatch(/^\d+(\.\d+)?[KM]?$/);

    expect(statTokenOut).not.toBeNull();
    expect(statTokenOut).not.toBe("—");
    expect(statTokenOut).not.toBe("NaN");
    expect(statTokenOut!.trim()).toMatch(/^\d+(\.\d+)?[KM]?$/);

    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-v3-10-summary-panel.png`,
      fullPage: true,
    });
  });

  test("4. Agent tag display", async () => {
    const agentTags = page.locator(".session-card .agent-tag");
    const count = await agentTags.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const text = await agentTags.nth(i).textContent();
        expect(text!.trim().length).toBeGreaterThan(0);
      }
    }

    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-v3-10-agent-tag.png`,
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
      path: `${EVIDENCE_DIR}/task-v3-10-git-diff.png`,
      fullPage: true,
    });
  });

  test("6. Sub-agent badge", async () => {
    const badges = page.locator(".sub-agent-badge");
    const count = await badges.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const text = await badges.nth(i).textContent();
        expect(text!.toLowerCase()).toContain("active");
        expect(text).not.toContain("0 active");
      }
    }

    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-v3-10-sub-agent.png`,
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
      path: `${EVIDENCE_DIR}/task-v3-10-selection-persist.png`,
      fullPage: true,
    });
  }, 15000);

  test("8. Notification banner exists", async () => {
    const banner = page.locator("#notif-banner");
    expect(await banner.count()).toBe(1);

    const exists = await banner.evaluate((el) => el instanceof HTMLElement);
    expect(exists).toBe(true);

    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-v3-10-notif-banner.png`,
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
      path: `${EVIDENCE_DIR}/task-v3-10-process-panel.png`,
      fullPage: true,
    });
  });
});
