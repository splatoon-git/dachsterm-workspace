"""Run only inside the disposable OpenSSH fixture; use synthetic files."""
import json, os, pathlib, select, subprocess, tempfile, time

catalog = json.loads(pathlib.Path('/tmp/assistant-commands.json').read_text())
hook_check = subprocess.run(['bash','-c','source /tmp/guide-hook.sh; cat /etc/hostname'],capture_output=True,text=True,check=True)
assert '\x1b' not in hook_check.stdout, 'wrapper polluted redirected output'
preserve = subprocess.run(['bash','-c',"cat() { printf custom; }; source /tmp/guide-hook.sh >/dev/null; cat"],capture_output=True,text=True,check=True)
assert preserve.stdout == 'custom', 'existing function was overwritten'
with tempfile.TemporaryDirectory(prefix='daxterm-guide-') as directory:
    root = pathlib.Path(directory)
    log = root / '한글 로그.txt'
    log.write_text("before\nalpha\nbeta\nalpha beta\na.b\naxb\nit's\nafter\n")
    (root / 'Sample.TXT').write_text('fixture')
    (root / 'link').symlink_to(log)
    def command(title):
        return next(c['command'] for c in catalog if c['title'] == title)
    def run(title, **values):
        value = command(title)
        for key, replacement in values.items(): value = value.replace(key, replacement)
        return subprocess.run(['bash', '-c', value], cwd=root, capture_output=True, text=True, check=True).stdout
    assert run('파일명 찾기', 파일명='한글') == './한글 로그.txt\n'
    assert run('대소문자 무시 파일명 찾기', 파일명='sample') == './Sample.TXT\n'
    assert run('실행 파일 위치', 프로그램명='bash').strip().endswith('/bash')
    assert run('관련 바이너리·매뉴얼 위치', 프로그램명='bash').startswith('bash:')
    assert run('링크의 실제 경로', 경로='link').strip() == str(log)
    assert run('특정 문구 포함 · cat 출력 필터', 파일명=log.name, 검색어='a.b') == 'a.b\n'
    assert 'alpha' not in run('특정 문구 제외', 파일명=log.name, 제외어='alpha')
    assert run('둘 중 하나 포함 · OR', 파일명=log.name, 문구1='alpha', 문구2='beta') == 'alpha\nbeta\nalpha beta\n'
    assert run('두 문구 모두 포함 · AND', 파일명=log.name, 문구1='alpha', 문구2='beta') == 'alpha beta\n'
    assert run('일치 줄 앞뒤 3줄', 파일명=log.name, 검색어='a.b').splitlines() == ['alpha','beta','alpha beta','a.b','axb',"it's",'after']
    assert run('특정 문구 포함 · cat 출력 필터', 파일명=log.name, 검색어="it'\\''s") == "it's\n"
    live = root / 'live.log'
    live.touch()
    cmd = command('실시간 두 문구 모두 · AND').replace('파일명',live.name).replace('문구1','alpha').replace('문구2','beta')
    child = subprocess.Popen(['bash','-c',cmd],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
    try:
        time.sleep(.3)
        live.write_text('alpha beta first\n')
        assert select.select([child.stdout],[],[],4)[0], 'buffered first output'
        assert child.stdout.readline() == b'alpha beta first\n'
        live.rename(root/'rotated.log')
        live.write_text('alpha beta rotated\n')
        assert select.select([child.stdout],[],[],9)[0], 'rotation not followed'
        assert child.stdout.readline() == b'alpha beta rotated\n'
    finally:
        import signal
        os.killpg(child.pid,signal.SIGINT)
        child.wait(timeout=3)
print('Linux catalog: find/path/literal/include/exclude/OR/AND/context/quote/live-buffering/rotation/SIGINT passed')
