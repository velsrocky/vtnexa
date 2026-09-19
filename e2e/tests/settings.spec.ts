import { test, expect } from '@playwright/test';

test.describe('Trusted paths settings', () => {
  test('rejects escape patterns with an inline error', async ({ page }) => {
    await page.goto('/');
    await page.getByTitle('Settings (trusted paths, etc)').click();
    await expect(page.getByText('Trusted Paths')).toBeVisible();
    await page.getByPlaceholder('e.g. docs/, src/generated/').fill('../secrets');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText("'..' and '.' are not allowed")).toBeVisible();
  });

  test('accepts a normal fragment', async ({ page }) => {
    await page.goto('/');
    await page.getByTitle('Settings (trusted paths, etc)').click();
    await page.getByPlaceholder('e.g. docs/, src/generated/').fill('docs/');
    await page.getByPlaceholder('Reason (optional)').fill('generated docs');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('docs', { exact: true })).toBeVisible();
  });
});
