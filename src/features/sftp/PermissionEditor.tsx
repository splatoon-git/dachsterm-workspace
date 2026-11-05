export function PermissionEditor({
  value,
  change,
}: {
  value: string;
  change: (value: string) => void;
}) {
  const numeric = /^[0-7]{1,3}$/.test(value) ? Number.parseInt(value, 8) : 0;
  return (
    <div className="permission-grid">
      <span>대상</span>
      <span>읽기</span>
      <span>쓰기</span>
      <span>실행</span>
      {['소유자', '그룹', '기타'].map((who, row) => (
        <div className="permission-row" key={who}>
          <strong>{who}</strong>
          {[4, 2, 1].map((bit, col) => {
            const mask = bit << (6 - row * 3);
            return (
              <input
                key={bit}
                type="checkbox"
                aria-label={`${who} ${['읽기', '쓰기', '실행'][col]}`}
                checked={!!(numeric & mask)}
                onChange={(e) =>
                  change(
                    (e.target.checked ? numeric | mask : numeric & ~mask)
                      .toString(8)
                      .padStart(3, '0'),
                  )
                }
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
