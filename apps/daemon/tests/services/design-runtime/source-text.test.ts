import { describe, expect, it } from 'vitest';
import { decodeDesignRuntimeSource } from '../../../src/services/design-runtime/source-text.js';

describe('selected design-runtime source decoding', () => {
  it('preserves UTF-8 BOM, line endings, and Unicode byte identity', () => {
    const bytes = Buffer.from('\ufeffexport const label = "你好 🌐";\r\n', 'utf8');
    expect(Buffer.from(decodeDesignRuntimeSource(bytes), 'utf8')).toEqual(bytes);
  });
  it.each([[0xff], [0xe2, 0x82], [0xc0, 0x80], [0xed, 0xa0, 0x80]])('rejects malformed UTF-8 without replacement bytes: %j', (...bytes) => {
    expect(() => decodeDesignRuntimeSource(Buffer.from(bytes))).toThrow('valid UTF-8');
  });
});
