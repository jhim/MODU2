export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export function inspectImage(bytes: Buffer, mime: SupportedImageMime) {
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.byteLength >= 24) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === 'image/webp' && bytes.byteLength >= 30) {
    const kind = bytes.subarray(12, 16).toString();
    if (kind === 'VP8X') {
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    } else if (kind === 'VP8 ' && bytes.subarray(23, 26).toString('hex') === '9d012a') {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const b1 = bytes[21]!, b2 = bytes[22]!, b3 = bytes[23]!, b4 = bytes[24]!;
      width = 1 + ((b2 & 0x3f) << 8) + b1;
      height = 1 + ((b4 & 0x0f) << 10) + (b3 << 2) + ((b2 & 0xc0) >> 6);
    }
  } else if (mime === 'image/jpeg' && bytes.byteLength >= 4) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1]!;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height) throw new Error('이미지 크기를 확인할 수 없습니다. 다시 저장한 JPG, PNG, WebP 파일을 선택해 주세요.');
  if (width > 10_000 || height > 10_000 || width * height > 30_000_000) throw new Error('사진은 한 변 10,000px, 총 30MP 이하만 처리할 수 있습니다.');
  return { width, height };
}
