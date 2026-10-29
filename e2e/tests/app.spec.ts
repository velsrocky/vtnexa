import { test, expect } from '@playwright/test';
import { stubTauri } from '../helpers/tauriStub';

test.describe('VTNexa App', () => {
  test('opens the editor with an explicitly unverified model when the server is unavailable', async ({ page }) => {
    await stubTauri(page);
    await page.route('http://localhost:11434/v1/models', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('HTTP 503');
    await page.getByTestId('skip-provider-check').click();
    await expect(page.getByTestId('workbench')).toBeVisible();
  });
  test('should load the app', async ({ page }) => {
    await stubTauri(page);
    await page.goto('/');
    await expect(page).toHaveTitle(/VTNexa/);
    await expect(page.getByRole("tab", { name: "Commander" })).toHaveAttribute("aria-selected", "true");
  });

  test("shows the first-run recovery view without a stored workspace", async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole("heading", { name: "Welcome to VTNexa" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Folder" })).toBeVisible();
  });

  test('should have a settings button', async ({ page }) => {
    await stubTauri(page);
    await page.goto('/');
    await expect(page.getByTitle('Settings (trusted paths, etc)')).toBeVisible();
    await page.getByTitle('Settings (trusted paths, etc)').click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
  });
});
