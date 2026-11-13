import QRCode from "qrcode";

/**
 * The invite code as a QR image.
 *
 * Error correction is set to `H` (about 30% of the modules can be lost), which
 * is what leaves room for the mark in the middle: the centre of a QR code is
 * redundancy, so covering it with the logo costs nothing.
 */
export async function inviteQrDataUrl(code: string, mark: string | null): Promise<string> {
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, `glyphi-teams://join?code=${encodeURIComponent(code)}`, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 280,
    color: { dark: "#241c12", light: "#f4ece0" }
  });

  const context = canvas.getContext("2d");
  if (!context || !mark) return canvas.toDataURL("image/png");

  const image = await loadImage(mark).catch(() => null);
  if (!image) return canvas.toDataURL("image/png");

  const size = Math.round(canvas.width * 0.24);
  const left = Math.round((canvas.width - size) / 2);
  const top = Math.round((canvas.height - size) / 2);
  const padding = Math.round(size * 0.12);

  context.fillStyle = "#f4ece0";
  context.beginPath();
  const radius = Math.round(size * 0.22);
  const x = left - padding;
  const y = top - padding;
  const width = size + padding * 2;
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + width, radius);
  context.arcTo(x + width, y + width, x, y + width, radius);
  context.arcTo(x, y + width, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
  context.fill();

  context.drawImage(image, left, top, size, size);
  return canvas.toDataURL("image/png");
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The app mark could not be drawn."));
    image.src = source;
  });
}
