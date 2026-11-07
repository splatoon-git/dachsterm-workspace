import { Icon } from '../components/Icon';
import { desktop } from '../lib/ipc';
import full from '../assets/brand/dachshund-full.png';

export function Welcome({
  newConnection,
  openLocal,
  showRecent,
}: {
  newConnection: () => void;
  openLocal: () => void;
  showRecent: () => void;
}) {
  return (
    <section className="welcome">
      <div className="welcome-topline">
        <span>WORKSPACE / OVERVIEW</span>
        <span>안전한 로컬 작업 공간</span>
      </div>
      <div className="welcome-hero">
        <div className="welcome-copy">
          <span className="eyebrow">A LITTLE COMPANION. A BETTER WORKFLOW.</span>
          <h1>서버 작업의 편안한 시작</h1>
          <p>
            터미널부터 파일까지, 한 곳에서.
            <br />
            자주 쓰는 서버를 연결하고 작업에 집중하세요.
          </p>
          <button className="primary" onClick={newConnection}>
            <Icon name="plus" size={17} />새 SSH 연결
          </button>
        </div>
        <img className="mascot" src={full} alt="장모 크림 닥스훈트 마스코트" />
      </div>
      <div className="welcome-section-title">
        <h2>빠르게 시작하기</h2>
        <span>내 도구, 내 서버</span>
      </div>
      <div className="quick-actions">
        <button onClick={newConnection}>
          <Icon name="server" size={23} />
          <strong>서버 연결</strong>
          <span>새 SSH 세션 등록</span>
          <Icon name="arrow" size={16} />
        </button>
        <button onClick={openLocal}>
          <Icon name="terminal" size={23} />
          <strong>로컬 터미널 열기</strong>
          <span>이 컴퓨터의 셸 · WSL</span>
          <Icon name="arrow" size={16} />
        </button>
        <button onClick={showRecent}>
          <Icon name="activity" size={23} />
          <strong>최근 작업</strong>
          <span>사용했던 서버 찾기</span>
          <Icon name="arrow" size={16} />
        </button>
      </div>
      <div className="welcome-section-title">
        <h2>연결 워크플로</h2>
        <span>SSH · SFTP · 멀티 터미널</span>
      </div>
      <div className="workflow-note">
        <span className="step-number">01</span>
        <div>
          <strong>연결할 서버를 등록하세요</strong>
          <p>호스트와 계정을 저장하고, 지문을 확인하면 준비 끝.</p>
        </div>
        <Icon name="chevron" size={18} />
      </div>
      <div className="workflow-note">
        <span className="step-number">02</span>
        <div>
          <strong>작업에 맞게 공간을 나누세요</strong>
          <p>여러 터미널과 원격 파일을 함께 보며 작업하세요.</p>
        </div>
        <Icon name="chevron" size={18} />
      </div>
      <small>
        {desktop
          ? '비밀번호 · 개인키 인증 지원'
          : '실제 접속과 저장은 데스크톱 앱에서 사용할 수 있습니다.'}
      </small>
    </section>
  );
}
