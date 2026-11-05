import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const output = new URL('../src-tauri/icons/', import.meta.url);
await mkdir(output, { recursive: true });
async function png(size) {
  const source = new URL(
    `../src/assets/brand/dachshund-${size < 48 ? 'face' : 'full'}.png`,
    import.meta.url,
  );
  return sharp(await readFile(source))
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}
for (const [name, size] of [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
])
  await writeFile(new URL(name, output), await png(size));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((buffer, i) => {
  const p = 6 + i * 16;
  header[p] = sizes[i] % 256;
  header[p + 1] = sizes[i] % 256;
  header.writeUInt16LE(1, p + 4);
  header.writeUInt16LE(32, p + 6);
  header.writeUInt32LE(buffer.length, p + 8);
  header.writeUInt32LE(offset, p + 12);
  offset += buffer.length;
});
await writeFile(new URL('icon.ico', output), Buffer.concat([header, ...images]));
const chunks = await Promise.all(
  [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ].map(async ([type, size]) => {
    const buffer = await png(size);
    const head = Buffer.alloc(8);
    head.write(type);
    head.writeUInt32BE(buffer.length + 8, 4);
    return Buffer.concat([head, buffer]);
  }),
);
const icns = Buffer.alloc(8);
icns.write('icns');
icns.writeUInt32BE(8 + chunks.reduce((sum, c) => sum + c.length, 0), 4);
await writeFile(new URL('icon.icns', output), Buffer.concat([icns, ...chunks]));
console.log('Generated PNG / ICO / ICNS; <48px face, >=48px full body.');
