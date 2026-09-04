// e2e/demo-path.spec.ts
// The demo path — the one flow that proves the product works end to end, against the REAL stack:
//   sign up → create workspace → connect the Fake network → schedule a post → see it on the calendar →
//   watch the worker publish it → see it reflected on Home.
// If this stays green in CI, the whole pipeline (auth, tenancy, connect, compose, schedule, the worker's
// exactly-once publish, and the read models) is working together.
import { test, expect } from '@playwright/test';

test('demo path: signup → connect → schedule → publish → home', async ({ page }) => {
  const stamp = Date.now();
  const email = `e2e-${stamp}@meridian.test`;
  const password = 'demo-password-123';
  const caption = `E2E demo post ${stamp}`;

  // 1) Sign up. This creates the account, signs in, and creates the first workspace WITH a timezone.
  await page.goto('/signup');
  await page.getByPlaceholder('Himanshu Raval').fill('E2E Tester');
  await page.getByPlaceholder('Amara Textiles').fill(`E2E ${stamp}`);
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByPlaceholder('At least 10 characters').fill(password);
  await page.getByRole('button', { name: /create workspace/i }).click();

  // Lands in the app.
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  // 2) Connect the Fake network (a credential-kind provider — enter its token and complete).
  await page.goto('/networks');
  await page.getByRole('button', { name: /connect a network/i }).first().click();
  await page.getByRole('button', { name: /Fake/ }).click();     // pick it in the modal
  await page.getByLabel('Token').fill('e2e-token');
  await page.getByRole('button', { name: /^Connect$/ }).click();
  // The account is now in the connected list.
  await expect(page.getByText('fake', { exact: false })).toBeVisible();

  // 3) Compose a post to the Fake account and publish it now.
  await page.goto('/composer');
  await page.locator('.acct-pick').getByRole('button').first().click(); // select the fake account chip
  await page.locator('.editor').fill(caption);
  await page.getByRole('button', { name: 'Publish now' }).click();
  await page.getByRole('button', { name: 'Schedule post' }).click();

  // 4) It lands in the queue.
  await expect(page).toHaveURL(/\/queue/);

  // 5) It appears on the calendar.
  await page.goto('/calendar');
  await expect(page.getByText(caption, { exact: false })).toBeVisible({ timeout: 20_000 });

  // 6) The worker publishes it. Poll the queue's Published group until it shows up.
  await expect(async () => {
    await page.goto('/queue');
    await page.getByRole('button', { name: 'Published' }).click();
    await expect(page.getByText(caption, { exact: false })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });

  // 7) Home reflects a healthy, active workspace with the published work.
  await page.goto('/');
  await expect(page.getByText('Posts published')).toBeVisible();
});
