import { describe, expect, it } from 'vitest';
import { insertTab, paneCapacity } from './workspaceTabs';
describe('workspace tab placement', () => {
  it('keeps a new tab visible when split panes are already full', () => {
    for (const layout of ['columns', 'rows', 'grid']) {
      const full = Array.from({ length: paneCapacity(layout) }, (_, index) => `tab-${index}`);
      expect(insertTab(full, 'new', layout).indexOf('new')).toBeLessThan(paneCapacity(layout));
    }
  });
  it('appends in the single layout, where the active tab is shown wherever it is', () => {
    expect(insertTab(['a', 'b'], 'new', 'single')).toEqual(['a', 'b', 'new']);
  });
});
