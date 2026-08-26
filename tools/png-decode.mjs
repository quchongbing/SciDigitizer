import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) return left;
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

export function decodePng(path) {
  const png = readFileSync(path);
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${path} is not a PNG file`);
  }
  let offset = 8;
  let header = null;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") compressed.push(data);
    offset += length + 12;
    if (type === "IEND") break;
  }
  if (!header || header.bitDepth !== 8 || header.interlace !== 0 || ![2, 6].includes(header.colorType)) {
    throw new Error(`${path} must be a non-interlaced 8-bit RGB/RGBA PNG`);
  }

  const channels = header.colorType === 2 ? 3 : 4;
  const rowBytes = header.width * channels;
  const filtered = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(header.height * rowBytes);
  let inputOffset = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = filtered[inputOffset];
    inputOffset += 1;
    const rowOffset = y * rowBytes;
    for (let byte = 0; byte < rowBytes; byte += 1) {
      const raw = filtered[inputOffset + byte];
      const left = byte >= channels ? pixels[rowOffset + byte - channels] : 0;
      const above = y > 0 ? pixels[rowOffset - rowBytes + byte] : 0;
      const upperLeft = y > 0 && byte >= channels ? pixels[rowOffset - rowBytes + byte - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[rowOffset + byte] = value & 255;
    }
    inputOffset += rowBytes;
  }

  const rgba = new Uint8ClampedArray(header.width * header.height * 4);
  for (let source = 0, target = 0; source < pixels.length; source += channels, target += 4) {
    rgba[target] = pixels[source];
    rgba[target + 1] = pixels[source + 1];
    rgba[target + 2] = pixels[source + 2];
    rgba[target + 3] = channels === 4 ? pixels[source + 3] : 255;
  }
  return { ...header, rgba };
}
