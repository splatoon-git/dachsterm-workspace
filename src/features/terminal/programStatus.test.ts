import { describe, expect, it, vi } from 'vitest';
import { parseProgramReport, ProgramStatus } from './programStatus';

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('OSC 7501 report parsing', () => {
  it('reads the example from the protocol', () => {
    const report = parseProgramReport(
      'state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/',
    );
    expect(report).toEqual({
      state: 'blocked',
      id: '',
      kind: 'permission',
      app: 'terraform',
      msg: 'Apply 3 to add, 1 to change, 0 to destroy?',
    });
  });

  it('skips malformed pairs, ignores unknown keys and lets the last value win', () => {
    expect(parseProgramReport('nope:=x:bad=a b:future=1:state=idle:state=done')).toEqual({
      state: 'done',
      id: '',
    });
  });

  it('ignores a report with no state, an unknown state or a bad id', () => {
    expect(parseProgramReport('app=x')).toBeNull();
    expect(parseProgramReport('state=paused')).toBeNull();
    expect(parseProgramReport('state=done:id=a//b')).toBeNull();
    expect(parseProgramReport(`state=done:id=${Array(9).fill('a').join('/')}`)).toBeNull();
    expect(parseProgramReport(`state=done:id=${'a'.repeat(33)}`)).toBeNull();
  });

  it('discards the whole report when free text is invalid', () => {
    // Outside the value characters, so only that pair is skipped.
    expect(parseProgramReport('state=done:msg=%%%')).toEqual({ state: 'done', id: '' });
    // Valid characters that do not decode as base64.
    expect(parseProgramReport('state=done:msg=A')).toBeNull();
    expect(parseProgramReport('state=done:msg=ab-_')).toBeNull();
    expect(parseProgramReport(`state=done:msg=${b64('a\nb')}`)).toBeNull();
    expect(parseProgramReport(`state=done:msg=${b64('a\u0085b')}`)).toBeNull();
    expect(parseProgramReport(`state=done:msg=${btoa('\xff\xfe')}`)).toBeNull();
    expect(parseProgramReport(`state=done:title=${b64('x'.repeat(193))}`)).toBeNull();
    expect(parseProgramReport(`state=done:msg=${'A'.repeat(2733)}`)).toBeNull();
    expect(parseProgramReport(`state=done:averyveryverylongkey=1`)).toBeNull();
    expect(parseProgramReport(`state=done:x=${'a'.repeat(4096)}`)).toBeNull();
  });

  it('accepts unpadded base64 and Korean text', () => {
    const encoded = b64('입력 대기').replace(/=+$/, '');
    expect(parseProgramReport(`state=done:msg=${encoded}`)).toMatchObject({ msg: '입력 대기' });
  });

  it('treats an invalid kind or app as absent and takes kind only with blocked', () => {
    expect(parseProgramReport('state=blocked:kind=other:app=a b')).toEqual({
      state: 'blocked',
      id: '',
    });
    expect(parseProgramReport('state=working:kind=auth')).toEqual({ state: 'working', id: '' });
  });
});

describe('program status records', () => {
  it('shows the most urgent record', () => {
    const status = new ProgramStatus();
    status.report('state=done:id=a');
    expect(status.snapshot()?.state).toBe('done');
    status.report('state=working:id=b');
    expect(status.snapshot()?.state).toBe('working');
    status.report('state=error:id=c');
    expect(status.snapshot()?.state).toBe('error');
    status.report('state=blocked:kind=auth:id=d');
    expect(status.snapshot()).toMatchObject({ state: 'blocked', kind: 'auth' });
  });

  it('shows nothing for idle', () => {
    const status = new ProgramStatus();
    status.report('state=idle');
    expect(status.snapshot()).toBeNull();
  });

  it('replaces a record completely', () => {
    const status = new ProgramStatus();
    status.report(`state=working:msg=${b64('one')}`);
    expect(status.snapshot()?.detail).toBe('one');
    status.report('state=working');
    expect(status.snapshot()?.detail).toBe('');
  });

  it('clears a record with its children, or everything without an id', () => {
    const status = new ProgramStatus();
    status.report('state=working:id=build');
    status.report('state=working:id=build/test');
    status.report('state=done:id=buildx');
    status.report('state=clear:id=build');
    expect(status.snapshot()?.state).toBe('done');
    status.report('state=clear');
    expect(status.snapshot()).toBeNull();
  });

  it('removes the least recently updated record past the cap', () => {
    const status = new ProgramStatus();
    status.report('state=blocked:id=old');
    for (let i = 0; i < 63; i++) status.report(`state=done:id=r${i}`);
    expect(status.snapshot()?.state).toBe('blocked');
    status.report('state=done:id=one-more');
    expect(status.snapshot()?.state).toBe('done');
  });

  it('drops only running states when the program ends', () => {
    const status = new ProgramStatus();
    status.report('state=working:id=a');
    status.report('state=blocked:id=b');
    status.programEnded();
    expect(status.snapshot()).toBeNull();
    status.report('state=done:id=c');
    status.programEnded();
    expect(status.snapshot()?.state).toBe('done');
  });

  it('hides finished states once seen, but never a program waiting for input', () => {
    const status = new ProgramStatus();
    status.report('state=done:id=a');
    status.acknowledge();
    expect(status.snapshot()).toBeNull();
    status.report('state=done:id=a');
    expect(status.snapshot()?.state).toBe('done');
    status.report('state=blocked:id=b');
    status.acknowledge();
    expect(status.snapshot()?.state).toBe('blocked');
  });

  it('removes hidden characters and shortens the text it shows', () => {
    const status = new ProgramStatus();
    status.report(`state=working:msg=${b64('safe\u202etxt.exe\u200b')}`);
    expect(status.snapshot()?.detail).toBe('safetxt.exe');
    status.report(`state=working:msg=${b64('x'.repeat(500))}`);
    expect(status.snapshot()?.detail).toHaveLength(200);
  });

  it('notifies listeners only when the summary changes', () => {
    const status = new ProgramStatus();
    const listener = vi.fn();
    status.subscribe(listener);
    status.report('state=working');
    status.report('state=working');
    expect(listener).toHaveBeenCalledTimes(1);
    const first = status.snapshot();
    status.report('state=working');
    expect(status.snapshot()).toBe(first);
  });
});
