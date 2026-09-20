import { test, expect } from '@playwright/test';

test.describe('VTNexa App', () => {
  test('should load the app', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/VTNexa/);
  });

  test('should have a settings button', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Settings (trusted paths, etc)')).toBeVisible();
  });
});
