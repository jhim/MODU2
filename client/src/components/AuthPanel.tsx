import { useState } from 'react';
import { authConfigured, supabase } from '../lib/auth';
import { Button, Input } from './ui';

export function AuthPanel({ onDone, onCancel, initialMode = 'login' }: { onDone: () => void; onCancel: () => void; initialMode?: 'login' | 'new-password' }) {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset' | 'new-password'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      if (!supabase) throw new Error('로그인을 사용하려면 Supabase 공개 URL과 anon key 설정이 필요합니다.');
      if (mode === 'login') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
        onDone();
      } else if (mode === 'signup') {
        const { error: authError } = await supabase.auth.signUp({ email, password,
          options: { emailRedirectTo: window.location.origin } });
        if (authError) throw authError;
        setMessage('인증 메일을 보냈습니다. 메일의 링크를 눌러 가입을 마쳐 주세요.');
      } else if (mode === 'reset') {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (authError) throw authError;
        setMessage('비밀번호 재설정 링크를 이메일로 보냈습니다.');
      } else {
        const { error: authError } = await supabase.auth.updateUser({ password });
        if (authError) throw authError;
        setMessage('비밀번호를 변경했습니다.');
        setMode('login');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '인증 요청을 처리하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  const heading = mode === 'signup' ? '이메일로 가입' : mode === 'reset' ? '비밀번호 재설정' : mode === 'new-password' ? '새 비밀번호 설정' : '로그인';
  return <main className="auth-page main-width">
    <button className="back-link" onClick={onCancel}>← 돌아가기</button>
    <section className="auth-panel">
      <div className="step-label"><span>MODU2 ACCOUNT</span> 내 학습 기록</div>
      <h1>{heading}</h1>
      <p>로그인하면 콘텐츠를 저장하고 내 학습 자료를 관리할 수 있어요.</p>
      {!authConfigured && <p className="inline-alert">Supabase Auth 환경변수를 설정한 뒤 이용할 수 있습니다.</p>}
      <form onSubmit={submit}>
        {mode !== 'new-password' && <label>이메일<Input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>}
        {mode !== 'reset' && <label>{mode === 'new-password' ? '새 비밀번호' : '비밀번호'}
          <Input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8}
            value={password} onChange={event => setPassword(event.target.value)} placeholder="8자 이상" />
        </label>}
        {error && <p className="error-message" role="alert">{error}</p>}
        {message && <p className="success-message" role="status">{message}</p>}
        <Button type="submit" disabled={busy || !authConfigured}>{busy ? '처리 중…' : heading}</Button>
      </form>
      <div className="auth-links">
        {mode === 'login' && <><button onClick={() => setMode('signup')}>처음 오셨나요? 가입하기</button><button onClick={() => setMode('reset')}>비밀번호를 잊으셨나요?</button></>}
        {mode !== 'login' && <button onClick={() => { setMode('login'); setError(''); setMessage(''); }}>로그인으로 돌아가기</button>}
      </div>
    </section>
  </main>;
}
