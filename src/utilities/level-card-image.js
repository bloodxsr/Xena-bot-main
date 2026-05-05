import { createCanvas, loadImage } from "@napi-rs/canvas";

const WIDTH = 980;
const HEIGHT = 320;
const AVATAR_SIZE = 164;

function normalizeHexColor(value, fallback) {
  const text = String(value ?? "").trim();
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text)) {
    return text.toLowerCase();
  }

  return fallback;
}

function colorWithAlpha(hexColor, alphaHex) {
  const normalized = normalizeHexColor(hexColor, "#000000");
  if (normalized.length === 4) {
    const r = normalized[1];
    const g = normalized[2];
    const b = normalized[3];
    return `#${r}${r}${g}${g}${b}${b}${alphaHex}`;
  }

  return `${normalized}${alphaHex}`;
}

function normalizeOpacity(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(numeric, 1));
}

function fontFamilyFromStyle(style) {
  const key = String(style || "default").trim().toLowerCase();
  if (key === "clean") {
    return '"Segoe UI", "Inter", sans-serif';
  }

  if (key === "cyber") {
    return '"Consolas", "Courier New", monospace';
  }

  return "sans-serif";
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }

  return Math.max(min, Math.min(max, numeric));
}

function formatInteger(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return "0";
  }

  return Math.trunc(numeric).toLocaleString("en-US");
}

function trimTextToWidth(ctx, text, maxWidth) {
  const source = String(text || "");
  if (!source) {
    return "";
  }

  if (ctx.measureText(source).width <= maxWidth) {
    return source;
  }

  let output = source;
  while (output.length > 1 && ctx.measureText(`${output}...`).width > maxWidth) {
    output = output.slice(0, -1);
  }

  return `${output}...`;
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillRoundedRect(ctx, x, y, width, height, radius, fillStyle) {
  ctx.save();
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function drawImageCover(ctx, image, width, height) {
  const imageWidth = Number(image?.width || 0);
  const imageHeight = Number(image?.height || 0);
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    return;
  }

  const scale = Math.max(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

function initialsFromName(displayName) {
  const parts = String(displayName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return "U";
  }

  return parts.map((entry) => entry[0].toUpperCase()).join("");
}

function drawBadge(ctx, options) {
  const x = options.x;
  const y = options.y;
  const width = options.width;
  const height = options.height;
  const label = String(options.label || "").toUpperCase();
  const value = String(options.value || "0");
  const accentColor = normalizeHexColor(options.accentColor, "#93c5fd");
  const fontFamily = String(options.fontFamily || "sans-serif");

  fillRoundedRect(ctx, x, y, width, height, 16, "rgba(15, 23, 42, 0.74)");
  ctx.save();
  drawRoundedRect(ctx, x, y, width, height, 16);
  ctx.strokeStyle = colorWithAlpha(accentColor, "66");
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = colorWithAlpha(accentColor, "dd");
  ctx.font = `600 13px ${fontFamily}`;
  ctx.fillText(label, x + 14, y + 24);

  ctx.fillStyle = "#f8fafc";
  ctx.font = `700 25px ${fontFamily}`;
  ctx.fillText(value, x + 14, y + 54);
}

async function drawAvatar(ctx, avatarUrl, displayName) {
  const x = 44;
  const y = (HEIGHT - AVATAR_SIZE) / 2;
  const radius = AVATAR_SIZE / 2;

  fillRoundedRect(ctx, x - 6, y - 6, AVATAR_SIZE + 12, AVATAR_SIZE + 12, radius + 10, "rgba(148, 163, 184, 0.18)");

  let image = null;
  if (avatarUrl) {
    try {
      image = await loadImage(String(avatarUrl));
    } catch {
      image = null;
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(x + radius, y + radius, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (image) {
    ctx.drawImage(image, x, y, AVATAR_SIZE, AVATAR_SIZE);
  } else {
    const fallbackGradient = ctx.createLinearGradient(x, y, x + AVATAR_SIZE, y + AVATAR_SIZE);
    fallbackGradient.addColorStop(0, "#334155");
    fallbackGradient.addColorStop(1, "#0f172a");
    ctx.fillStyle = fallbackGradient;
    ctx.fillRect(x, y, AVATAR_SIZE, AVATAR_SIZE);

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "700 58px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initialsFromName(displayName), x + radius, y + radius + 4);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  ctx.restore();
}

export async function renderLevelCardImage(options) {
  const displayName = String(options.displayName || "Unknown User").trim() || "Unknown User";
  const avatarUrl = options.avatarUrl ? String(options.avatarUrl) : null;
  const primaryColor = normalizeHexColor(options.primaryColor, "#63d1ff");
  const accentColor = normalizeHexColor(options.accentColor, "#4ab8ff");
  const overlayOpacity = normalizeOpacity(options.overlayOpacity, 0.62);
  const fontFamily = fontFamilyFromStyle(options.fontStyle);
  const backgroundUrl = options.backgroundUrl ? String(options.backgroundUrl).trim() : "";

  const level = Math.max(0, Math.trunc(Number(options.level || 0)));
  const rank = Math.max(1, Math.trunc(Number(options.rank || 1)));
  const trackedMembers = Math.max(rank, Math.trunc(Number(options.trackedMembers || rank)));
  const progressXp = Math.max(0, Number(options.progressXp || 0));
  const progressRequired = Math.max(1, Number(options.progressRequired || 1));
  const progressPercent = Math.round(clamp((progressXp / progressRequired) * 100, 0, 100));
  const totalXp = Math.max(0, Number(options.totalXp || 0));
  const messageCount = Math.max(0, Number(options.messageCount || 0));
  const xpToNext = Math.max(0, progressRequired - progressXp);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  let customBackground = null;
  if (backgroundUrl) {
    try {
      customBackground = await loadImage(backgroundUrl);
    } catch {
      customBackground = null;
    }
  }

  if (customBackground) {
    drawImageCover(ctx, customBackground, WIDTH, HEIGHT);
    ctx.fillStyle = `rgba(8, 12, 20, ${overlayOpacity})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  } else {
    const backgroundGradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    backgroundGradient.addColorStop(0, "#121820");
    backgroundGradient.addColorStop(0.55, "#1a2431");
    backgroundGradient.addColorStop(1, "#202d3d");
    ctx.fillStyle = backgroundGradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  const glowGradient = ctx.createRadialGradient(760, 40, 20, 760, 40, 320);
  glowGradient.addColorStop(0, colorWithAlpha(accentColor, "3d"));
  glowGradient.addColorStop(1, colorWithAlpha(accentColor, "00"));
  ctx.fillStyle = glowGradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const secondaryGlow = ctx.createRadialGradient(160, 280, 30, 160, 280, 260);
  secondaryGlow.addColorStop(0, colorWithAlpha(primaryColor, "2e"));
  secondaryGlow.addColorStop(1, colorWithAlpha(primaryColor, "00"));
  ctx.fillStyle = secondaryGlow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  fillRoundedRect(ctx, 24, 24, WIDTH - 48, HEIGHT - 48, 28, "rgba(16, 24, 34, 0.78)");
  ctx.save();
  drawRoundedRect(ctx, 24, 24, WIDTH - 48, HEIGHT - 48, 28);
  ctx.strokeStyle = "rgba(142, 173, 207, 0.3)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  await drawAvatar(ctx, avatarUrl, displayName);

  ctx.fillStyle = "#f8fafc";
  ctx.font = `700 42px ${fontFamily}`;
  const displayNameText = trimTextToWidth(ctx, displayName, 500);
  ctx.fillText(displayNameText, 240, 92);

  const levelPillX = 600;
  const levelPillY = 58;
  const levelPillWidth = 142;
  const levelPillHeight = 34;
  const levelGradient = ctx.createLinearGradient(levelPillX, levelPillY, levelPillX + levelPillWidth, levelPillY);
  levelGradient.addColorStop(0, colorWithAlpha(accentColor, "cc"));
  levelGradient.addColorStop(1, colorWithAlpha(primaryColor, "cc"));
  fillRoundedRect(ctx, levelPillX, levelPillY, levelPillWidth, levelPillHeight, 14, levelGradient);

  ctx.fillStyle = "#06101d";
  ctx.font = `700 18px ${fontFamily}`;
  ctx.fillText(`LEVEL ${level}`, levelPillX + 17, levelPillY + 24);

  ctx.fillStyle = colorWithAlpha(accentColor, "f0");
  ctx.font = `600 20px ${fontFamily}`;
  ctx.fillText(`Rank #${rank}/${trackedMembers}`, 240, 130);

  const progressTrackX = 240;
  const progressTrackY = 164;
  const progressTrackWidth = 488;
  const progressTrackHeight = 30;
  const progressRatio = clamp(progressXp / progressRequired, 0, 1);
  const filledWidth = progressRatio > 0 ? Math.max(12, Math.round(progressTrackWidth * progressRatio)) : 0;

  fillRoundedRect(ctx, progressTrackX, progressTrackY, progressTrackWidth, progressTrackHeight, 14, "rgba(120, 130, 145, 0.45)");
  ctx.save();
  drawRoundedRect(ctx, progressTrackX, progressTrackY, progressTrackWidth, progressTrackHeight, 14);
  ctx.strokeStyle = "rgba(220, 230, 245, 0.22)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  const progressGradient = ctx.createLinearGradient(progressTrackX, 0, progressTrackX + progressTrackWidth, 0);
  progressGradient.addColorStop(0, accentColor);
  progressGradient.addColorStop(1, primaryColor);
  if (filledWidth > 0) {
    fillRoundedRect(ctx, progressTrackX, progressTrackY, filledWidth, progressTrackHeight, 14, progressGradient);
  }

  ctx.fillStyle = "#e2e8f0";
  ctx.font = `600 17px ${fontFamily}`;
  ctx.fillText(`${progressPercent}% progress`, 240, 220);

  ctx.fillStyle = "#94a3b8";
  ctx.font = `500 15px ${fontFamily}`;
  ctx.fillText(
    `XP ${formatInteger(progressXp)}/${formatInteger(progressRequired)} (${formatInteger(xpToNext)} to next level)`,
    240,
    246
  );

  ctx.fillStyle = colorWithAlpha(primaryColor, "e8");
  ctx.font = `600 14px ${fontFamily}`;
  ctx.fillText(`Next Level: ${level + 1}`, 240, 272);

  drawBadge(ctx, {
    label: "Total XP",
    value: formatInteger(totalXp),
    x: 756,
    y: 56,
    width: 192,
    height: 68,
    accentColor,
    fontFamily
  });

  drawBadge(ctx, {
    label: "Messages",
    value: formatInteger(messageCount),
    x: 756,
    y: 136,
    width: 192,
    height: 68,
    accentColor,
    fontFamily
  });

  drawBadge(ctx, {
    label: "To Next",
    value: formatInteger(xpToNext),
    x: 756,
    y: 216,
    width: 192,
    height: 68,
    accentColor,
    fontFamily
  });

  return canvas.toBuffer("image/png");
}
