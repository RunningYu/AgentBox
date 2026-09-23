import { describe, expect, it } from 'vitest';
import { buildLineDiff } from './ChangeTrackerPanel';

describe('buildLineDiff', () => {
  it('returns no rows when content is unchanged', () => {
    const diff = buildLineDiff('a\nb\nc', 'a\nb\nc');

    expect(diff.added).toBe(0);
    expect(diff.deleted).toBe(0);
    expect(diff.firstChangedLine).toBeNull();
    expect(diff.rows).toEqual([]);
  });

  it('marks added and deleted lines with line numbers', () => {
    const diff = buildLineDiff(
      'line 1\nold value\nline 3',
      'line 1\nnew value\nline 3\nline 4',
    );

    expect(diff.added).toBe(2);
    expect(diff.deleted).toBe(1);
    expect(diff.firstChangedLine).toBe(2);
    expect(diff.rows).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'line 1' },
      { kind: 'del', oldLine: 2, newLine: null, text: 'old value' },
      { kind: 'add', oldLine: null, newLine: 2, text: 'new value' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'line 3' },
      { kind: 'add', oldLine: null, newLine: 4, text: 'line 4' },
    ]);
  });

  it('falls back to prefix and suffix diff for large files', () => {
    const before = Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\n');
    const after = Array.from({ length: 600 }, (_, index) => (index === 300 ? 'changed line' : `line ${index}`)).join('\n');

    const diff = buildLineDiff(before, after);

    expect(diff.deleted).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.rows.some((row) => row.kind === 'del' && row.text === 'line 300')).toBe(true);
    expect(diff.rows.some((row) => row.kind === 'add' && row.text === 'changed line')).toBe(true);
  });

  it('does not mark a large shifted block as all changed when only one line is inserted', () => {
    const before = [
      ...Array.from({ length: 120 }, (_, index) => `import demo.Type${index};`),
      ...Array.from({ length: 1_000 }, (_, index) => `  existing statement ${index};`),
    ].join('\n');
    const after = [
      ...Array.from({ length: 90 }, (_, index) => `import demo.Type${index};`),
      'import demo.InsertedType;',
      ...Array.from({ length: 30 }, (_, index) => `import demo.Type${index + 90};`),
      ...Array.from({ length: 1_000 }, (_, index) => `  existing statement ${index};`),
    ].join('\n');

    const diff = buildLineDiff(before, after);

    expect(diff.added).toBe(1);
    expect(diff.deleted).toBe(0);
    expect(diff.rows.filter((row) => row.kind === 'add').map((row) => row.text)).toEqual(['import demo.InsertedType;']);
  });

  it('keeps a large Java method edit scoped near the changed block', () => {
    const beforeLines = [
      ...Array.from({ length: 120 }, (_, index) => `import demo.Type${index};`),
      'public class DemoService {',
      ...Array.from({ length: 430 }, (_, index) => `  private void unchangedBefore${index}() {}`),
      '  /**',
      '   * 构建商品添加或编辑--sku数据',
      '   */',
      '  public List<ProductSkuAndAttrDto> buildProductSkuData(MallProductAddOrEditReq req) throws Exception {',
      '    return this.buildProductSkuData(req, false);',
      '  }',
      ...Array.from({ length: 1_400 }, (_, index) => `  private void unchangedAfter${index}() {}`),
      '}',
    ];
    const afterLines = [
      ...Array.from({ length: 120 }, (_, index) => `import demo.Type${index};`),
      'public class DemoService {',
      ...Array.from({ length: 430 }, (_, index) => `  private void unchangedBefore${index}() {}`),
      '  /**',
      '   * 构建商品 SKU 定价数据',
      '   */',
      '  public List<ProductSkuAndAttrDto> buildProductSkuData(MallProductAddOrEditReq req, boolean useNew) throws Exception {',
      '    return this.buildProductSkuData(req, useNew);',
      '  }',
      ...Array.from({ length: 1_400 }, (_, index) => `  private void unchangedAfter${index}() {}`),
      '}',
    ];

    const diff = buildLineDiff(beforeLines.join('\n'), afterLines.join('\n'));

    expect(diff.added).toBe(3);
    expect(diff.deleted).toBe(3);
    expect(diff.firstChangedLine).toBe(553);
    expect(diff.rows.length).toBeLessThan(20);
    expect(diff.rows.some((row) => row.kind === 'del' && row.text.includes('构建商品添加或编辑--sku数据'))).toBe(true);
    expect(diff.rows.some((row) => row.kind === 'add' && row.text.includes('构建商品 SKU 定价数据'))).toBe(true);
  });
});
