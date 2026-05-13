/**
 * Generate PNG logos for GateTest branding.
 * Outputs: icon-400.png, icon-180.png, logo-512.png
 * Run: node scripts/generate-logos.js
 */

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'website', 'public');

function drawIcon(ctx, size) {
  const s = size / 400; // scale factor

  // Background rounded rect
  ctx.fillStyle = '#0f0f23';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, 80 * s);
  ctx.fill();

  // Border
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 3 * s;
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.roundRect(4 * s, 4 * s, size - 8 * s, size - 8 * s, 76 * s);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Shield body
  ctx.fillStyle = '#0f0f23';
  ctx.beginPath();
  ctx.moveTo(200 * s, 55 * s);
  ctx.lineTo(310 * s, 115 * s);
  ctx.lineTo(310 * s, 245 * s);
  ctx.quadraticCurveTo(310 * s, 320 * s, 200 * s, 355 * s);
  ctx.quadraticCurveTo(90 * s, 320 * s, 90 * s, 245 * s);
  ctx.lineTo(90 * s, 115 * s);
  ctx.closePath();
  ctx.fill();

  // Shield outline with glow
  ctx.strokeStyle = '#818cf8';
  ctx.lineWidth = 5 * s;
  ctx.shadowColor = '#6366f1';
  ctx.shadowBlur = 20 * s;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Checkmark
  const grad = ctx.createLinearGradient(155 * s, 165 * s, 260 * s, 250 * s);
  grad.addColorStop(0, '#6366f1');
  grad.addColorStop(1, '#8b5cf6');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 14 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(155 * s, 215 * s);
  ctx.lineTo(190 * s, 250 * s);
  ctx.lineTo(260 * s, 165 * s);
  ctx.stroke();

  // Scan lines
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1 * s;
  ctx.lineCap = 'butt';
  [175, 205, 235, 265].forEach((y, i) => {
    ctx.globalAlpha = 0.15 - i * 0.03;
    ctx.beginPath();
    ctx.moveTo(115 * s, y * s);
    ctx.lineTo(285 * s, y * s);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

function drawLogo(ctx, size) {
  const s = size / 512;

  // Background circle
  ctx.fillStyle = '#0a0a1a';
  ctx.beginPath();
  ctx.arc(256 * s, 256 * s, 250 * s, 0, Math.PI * 2);
  ctx.fill();

  // Circle border
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 4 * s;
  ctx.stroke();

  // Outer ring
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 2 * s;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(256 * s, 256 * s, 230 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Shield
  ctx.beginPath();
  ctx.moveTo(256 * s, 80 * s);
  ctx.lineTo(380 * s, 150 * s);
  ctx.lineTo(380 * s, 300 * s);
  ctx.quadraticCurveTo(380 * s, 380 * s, 256 * s, 430 * s);
  ctx.quadraticCurveTo(132 * s, 380 * s, 132 * s, 300 * s);
  ctx.lineTo(132 * s, 150 * s);
  ctx.closePath();

  // Shield fill
  ctx.fillStyle = '#0a0a1a';
  ctx.globalAlpha = 0.8;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Shield outline with glow
  ctx.strokeStyle = '#818cf8';
  ctx.lineWidth = 6 * s;
  ctx.shadowColor = '#6366f1';
  ctx.shadowBlur = 24 * s;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Checkmark
  const grad = ctx.createLinearGradient(200 * s, 200 * s, 320 * s, 300 * s);
  grad.addColorStop(0, '#6366f1');
  grad.addColorStop(1, '#8b5cf6');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 16 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#818cf8';
  ctx.shadowBlur = 12 * s;
  ctx.beginPath();
  ctx.moveTo(200 * s, 260 * s);
  ctx.lineTo(240 * s, 300 * s);
  ctx.lineTo(320 * s, 200 * s);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Scan lines
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1 * s;
  ctx.lineCap = 'butt';
  [210, 240, 270, 300, 330].forEach((y, i) => {
    ctx.globalAlpha = 0.2 - i * 0.03;
    ctx.beginPath();
    ctx.moveTo(160 * s, y * s);
    ctx.lineTo(352 * s, y * s);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // Circuit dots
  ctx.fillStyle = '#818cf8';
  [[256, 95, 5], [370, 158, 4], [142, 158, 4], [256, 415, 5]].forEach(([x, y, r]) => {
    ctx.beginPath();
    ctx.arc(x * s, y * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  });

  // GATETEST text
  ctx.font = `800 ${36 * s}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText('GATE', 228 * s, 480 * s);
  ctx.fillStyle = '#818cf8';
  ctx.fillText('TEST', 328 * s, 480 * s);
}

// Generate icon at 400px (GitHub avatar, Stripe)
const icon400 = createCanvas(400, 400);
drawIcon(icon400.getContext('2d'), 400);
fs.writeFileSync(path.join(outDir, 'icon-400.png'), icon400.toBuffer('image/png'));
console.log('Generated: icon-400.png (400x400)');

// Generate icon at 180px (Apple touch icon)
const icon180 = createCanvas(180, 180);
drawIcon(icon180.getContext('2d'), 180);
fs.writeFileSync(path.join(outDir, 'icon-180.png'), icon180.toBuffer('image/png'));
console.log('Generated: icon-180.png (180x180)');

// Generate logo at 512px (Stripe branding, social)
const logo512 = createCanvas(512, 512);
drawLogo(logo512.getContext('2d'), 512);
fs.writeFileSync(path.join(outDir, 'logo-512.png'), logo512.toBuffer('image/png'));
console.log('Generated: logo-512.png (512x512)');

console.log(`\nAll PNGs saved to: ${outDir}`);
console.log('Upload icon-400.png to GitHub org avatar');
console.log('Upload logo-512.png to Stripe branding');
