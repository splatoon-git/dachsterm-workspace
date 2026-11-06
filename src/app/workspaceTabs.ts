export const paneCapacity = (layout: string) =>
  layout === 'grid' ? 4 : layout === 'single' ? 1 : 2;
/** Split views render only the first paneCapacity tabs, so a new active tab goes in front. */
export const insertTab = <T>(tabs: T[], tab: T, layout: string): T[] =>
  layout === 'single' ? [...tabs, tab] : [tab, ...tabs];
