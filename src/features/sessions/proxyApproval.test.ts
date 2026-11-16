import { describe, expect, it } from 'vitest';
import { blankProfile, type Profile } from '../../lib/ipc';
import { approval, initialSelection, unapproved } from './proxyApproval';

const plain: Profile = { ...blankProfile(), id: 'plain' };
const jump: Profile = {
  ...blankProfile(),
  id: 'jump',
  proxy: { kind: 'command', command: 'nc %h %p' },
};
const other: Profile = { ...jump, id: 'other' };

describe('proxy command approval on import', () => {
  it('leaves sessions that run a command unticked until the user ticks them', () => {
    expect(initialSelection([plain, jump, other])).toEqual(['plain']);
    expect(unapproved([plain, jump], ['plain']).map((p) => p.id)).toEqual(['jump']);
    expect(unapproved([plain, jump], ['plain', 'jump'])).toEqual([]);
  });
  it('approves only the ticked commands that are being saved', () => {
    const plan = { token: 't', sessions: [] };
    expect(approval(plan, [plain, jump], ['plain', 'jump', 'other'])).toEqual({
      token: 't',
      ids: ['jump'],
    });
    expect(approval(null, [plain], ['plain'])).toBeNull();
  });
});
