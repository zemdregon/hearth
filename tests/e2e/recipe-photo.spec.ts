import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createDemo } from '../../src/client/demo';

async function openPhotoImport(page: Page) {
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...createDemo(), demo: false } }));
  await page.goto('/#recipes');
  await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Scan a photo', exact: true }).click();
}

const draft = { recipe: { title: 'Photo preparation fixture', description: 'A browser test fixture, not live AI.', servings: 2, prepMinutes: 0, cookMinutes: 10, ingredients: [{ name: 'flour', quantity: 2, unit: 'cups' }], steps: ['Mix the flour.'], tags: [], favorite: false }, warnings: ['Check the image against this test draft.'] };

test('a large phone photo is prepared locally, previewed, and uploaded only on explicit import', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  let uploads = 0;
  await page.route('**/api/recipes/import', async route => {
    uploads += 1;
    const body = route.request().postDataJSON();
    expect(Object.keys(body).sort()).toEqual(['mimeType', 'mode', 'value']);
    expect(body).toMatchObject({ mode: 'image', mimeType: 'image/jpeg' });
    expect(Buffer.from(body.value, 'base64').byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    await route.fulfill({ json: draft });
  });
  await openPhotoImport(page);
  // Deterministic synthetic camera noise plus a readable recipe card; no personal photo.
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4096; canvas.height = 3072;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 2197;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255; pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    context.fillStyle = '#fff'; context.fillRect(600, 400, 2900, 2100);
    context.fillStyle = '#203f2a'; context.font = '128px sans-serif';
    ['Sunday pancakes', '2 cups flour', '1 egg', '1 cup milk', 'Mix gently. Cook until golden.'].forEach((line, index) => context.fillText(line, 780, 740 + index * 260));
    return canvas.toDataURL('image/jpeg', 0.98).split(',')[1];
  });
  const sourceBytes = Buffer.from(source, 'base64');
  expect(sourceBytes.byteLength).toBeGreaterThan(4 * 1024 * 1024);
  expect(sourceBytes.byteLength).toBeLessThan(25 * 1024 * 1024);
  await page.getByLabel('Recipe photo', { exact: true }).setInputFiles({ name: 'large-phone-recipe.jpg', mimeType: 'image/jpeg', buffer: sourceBytes });
  const preview = page.getByRole('img', { name: 'Selected recipe photo preview' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width: 2560, height: 1920 });
  await expect(page.getByRole('dialog')).toContainText('The photo stays on this device until you create a draft.');
  expect(uploads).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('prepared-recipe-photo.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create a recipe draft' }).click();
  await expect(page.getByRole('dialog', { name: 'Review your imported recipe' })).toBeVisible();
  expect(uploads).toBe(1);
});

test('JPEG orientation is normalized and the same photo can be removed and chosen again', async ({ page }) => {
  await openPhotoImport(page);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f00'; context.fillRect(0, 0, 60, 80);
    context.fillStyle = '#00f'; context.fillRect(60, 0, 60, 80);
    return canvas.toDataURL('image/jpeg', 1).split(',')[1];
  });
  const jpeg = Buffer.from(base64, 'base64');
  // An EXIF orientation-6 fixture: display the landscape pixels rotated 90° clockwise.
  const app1 = Buffer.alloc(36);
  app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(34, 2);
  app1.write('Exif\0\0', 4, 'binary'); app1.write('II', 10); app1.writeUInt16LE(42, 12); app1.writeUInt32LE(8, 14);
  app1.writeUInt16LE(1, 18); app1.writeUInt16LE(0x112, 20); app1.writeUInt16LE(3, 22); app1.writeUInt32LE(1, 24); app1.writeUInt16LE(6, 28);
  const file = { name: 'rotated-recipe.jpg', mimeType: 'image/jpeg', buffer: Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]) };
  await page.getByLabel('Recipe photo', { exact: true }).setInputFiles(file);
  const preview = page.getByRole('img', { name: 'Selected recipe photo preview' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }))).toEqual({ width: 80, height: 120 });
  const inspected = await preview.evaluate(async element => {
    const image = element as HTMLImageElement;
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const top = Array.from(context.getImageData(40, 20, 1, 1).data);
    const bottom = Array.from(context.getImageData(40, 100, 1, 1).data);
    const bytes = await (await fetch(image.src)).arrayBuffer();
    return { top, bottom, metadata: new TextDecoder().decode(bytes).includes('Exif') };
  });
  expect(inspected.top[0]).toBeGreaterThan(200); expect(inspected.top[2]).toBeLessThan(30);
  expect(inspected.bottom[2]).toBeGreaterThan(200); expect(inspected.bottom[0]).toBeLessThan(30);
  expect(inspected.metadata).toBe(false);
  await page.getByRole('button', { name: 'Remove photo', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(await page.getByLabel('Recipe photo', { exact: true }).inputValue()).toBe('');
  await page.getByLabel('Recipe photo', { exact: true }).setInputFiles(file);
  await expect(preview).toBeVisible();
});

test('unsupported, undecodable, excessive-byte, and extreme-dimension images are rejected before upload', async ({ page }) => {
  test.setTimeout(60_000);
  let uploads = 0;
  await page.route('**/api/recipes/import', route => { uploads += 1; return route.fulfill({ json: draft }); });
  await openPhotoImport(page);
  const input = page.getByLabel('Recipe photo', { exact: true });
  await input.setInputFiles({ name: 'unsupported.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Choose a JPG, PNG, or WebP photo.');
  await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('This photo could not be opened.');
  const huge = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(huge); huge.writeUInt32BE(13, 8); huge.write('IHDR', 12); huge.writeUInt32BE(30000, 16); huge.writeUInt32BE(30000, 20);
  await input.setInputFiles({ name: 'excessive-dimensions.png', mimeType: 'image/png', buffer: huge });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('This photo is too large to open safely.');
  await input.setInputFiles({ name: 'excessive-bytes.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Choose a photo under 25 MB.');
  await expect(page.getByRole('img', { name: 'Selected recipe photo preview' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create a recipe draft' })).toBeDisabled();
  expect(uploads).toBe(0);
});

test('transparent recipe images receive a white background and WebP photos remain supported', async ({ page }) => {
  await openPhotoImport(page);
  for (const type of ['image/png', 'image/webp']) {
    const source = await page.evaluate(type => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
      const context = canvas.getContext('2d')!; context.fillStyle = '#000'; context.fillRect(20, 20, 30, 30);
      return canvas.toDataURL(type).split(',')[1];
    }, type);
    await page.getByLabel('Recipe photo', { exact: true }).setInputFiles({ name: `transparent.${type.split('/')[1]}`, mimeType: type, buffer: Buffer.from(source, 'base64') });
    const preview = page.getByRole('img', { name: 'Selected recipe photo preview' });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(240);
    const background = await preview.evaluate(image => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
      const context = canvas.getContext('2d')!; context.drawImage(image as HTMLImageElement, 0, 0);
      return Array.from(context.getImageData(200, 100, 1, 1).data);
    });
    expect(background).toEqual([255, 255, 255, 255]);
    await page.getByRole('button', { name: 'Remove photo', exact: true }).click();
  }
});
