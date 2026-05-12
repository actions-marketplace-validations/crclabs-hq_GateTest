import { test, expect } from "@playwright/test";

test.describe("Landing Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("loads and shows hero section", async ({ page }) => {
    await expect(page).toHaveTitle(/GateTest/);
    await expect(
      page.getByRole("heading", { name: /Your code has problems/ })
    ).toBeVisible();
  });

  test("navbar renders with logo and links", async ({ page }) => {
    await expect(page.locator('a[href="/"]').first()).toBeVisible();
    await expect(page.locator('a[href="#features"]').first()).toBeVisible();
    await expect(page.locator('a[href="#modules"]').first()).toBeVisible();
    await expect(page.locator('a[href="#pricing"]').first()).toBeVisible();
  });

  test("pricing section renders with tiers", async ({ page }) => {
    const pricing = page.locator("#pricing");
    await pricing.scrollIntoViewIfNeeded();
    await expect(pricing).toBeVisible();
    await expect(page.getByText("$29", { exact: true })).toBeVisible();
    await expect(page.getByText("$99", { exact: true })).toBeVisible();
    await expect(page.getByText("Quick Scan").first()).toBeVisible();
    await expect(page.getByText("Full Scan").first()).toBeVisible();
  });

  test("repo URL input exists in pricing section", async ({ page }) => {
    const input = page.locator("#repo-url");
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", /github\.com/);
  });

  test("repo URL validation rejects non-GitHub URLs", async ({ page }) => {
    const input = page.locator("#repo-url");
    await input.scrollIntoViewIfNeeded();
    await input.fill("https://example.com/repo");
    // Click the Quick Scan button
    await page.locator("text=Run Quick Scan").click();
    await expect(page.locator("text=Enter a valid GitHub")).toBeVisible();
  });

  test("CTA buttons point to pricing", async ({ page }) => {
    const primaryCta = page.locator('a[href="#pricing"]').first();
    await expect(primaryCta).toBeVisible();
  });

  test("GitHub App install link exists", async ({ page }) => {
    const link = page.locator('a[href="/github/setup"]').first();
    await expect(link).toBeVisible();
  });

  test("footer renders with legal links", async ({ page }) => {
    const footer = page.locator("footer");
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();
    await expect(page.locator('a[href="/legal/privacy"]')).toBeVisible();
    await expect(page.locator('a[href="/legal/terms"]')).toBeVisible();
  });

  test("footer has contact email", async ({ page }) => {
    await expect(
      page.locator('a[href="mailto:hello@gatetest.ai"]')
    ).toBeVisible();
  });
});

test.describe("Legal Pages", () => {
  test("terms of service loads", async ({ page }) => {
    await page.goto("/legal/terms");
    await expect(page).toHaveTitle(/Terms of Service/);
    await expect(page.locator("text=Agreement to Terms")).toBeVisible();
  });

  test("privacy policy loads", async ({ page }) => {
    await page.goto("/legal/privacy");
    await expect(page).toHaveTitle(/Privacy Policy/);
    await expect(page.locator("text=Who We Are")).toBeVisible();
  });

});

test.describe("SEO & Meta Tags", () => {
  test("has correct meta description", async ({ page }) => {
    await page.goto("/");
    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute("content", /scan your entire codebase/);
  });

  test("has Open Graph tags", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      /GateTest/
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      "https://gatetest.ai"
    );
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute(
      "content",
      "website"
    );
  });

  test("has Twitter card tags", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      "content",
      "summary_large_image"
    );
  });
});

test.describe("GitHub Setup Page", () => {
  test("loads and shows install instructions", async ({ page }) => {
    await page.goto("/github/setup");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});

test.describe("Admin Page", () => {
  test("shows login form when not authenticated", async ({ page }) => {
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "Admin Access" })
    ).toBeVisible();
  });
});

test.describe("Scan Status Page", () => {
  test("loads without crashing", async ({ page }) => {
    await page.goto("/scan/status");
    // Should load without errors (may show waiting state)
    await expect(page.locator("body")).toBeVisible();
  });
});
