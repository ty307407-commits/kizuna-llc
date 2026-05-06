import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const TO_EMAIL = process.env.CONTACT_TO_EMAIL || 'support@kizuna-llc.net';
const FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || 'KIZUNA Contact <noreply@kizuna-llc.net>';

const SUBJECT_LABELS = {
  consulting: 'コンサルティング・コーチング',
  pr: 'PR・メディア取材',
  marketing: 'マーケティング・ブランディング',
  system: 'システム開発・AI活用',
  partnership: '業務提携・パートナーシップ',
  other: 'その他',
};

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (s) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[s]));
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const {
    company = '',
    name = '',
    email = '',
    tel = '',
    contact_method = '',
    subject = '',
    message = '',
    privacy_agreed = '',
    _gotcha = '',
    'cf-turnstile-response': turnstileToken = '',
  } = body;

  // ハニーポット（ボット弾き・静かに成功扱い）
  if (_gotcha) {
    return res.status(200).json({ ok: true });
  }

  // 必須チェック
  if (!name.trim() || !isEmail(email) || !message.trim()) {
    return res.status(400).json({ error: '入力内容を確認してください' });
  }

  if (!privacy_agreed) {
    return res.status(400).json({ error: 'プライバシーポリシーへの同意が必要です' });
  }

  // Cloudflare Turnstile 検証
  if (!turnstileToken) {
    return res.status(400).json({ error: 'ボット確認が完了していません' });
  }

  try {
    const verifyParams = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET_KEY || '',
      response: turnstileToken,
    });
    // クライアントIP取得（Vercel/CF経由）
    const clientIp = req.headers['cf-connecting-ip']
      || req.headers['x-real-ip']
      || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (clientIp) verifyParams.append('remoteip', clientIp);

    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verifyParams,
    });
    const verifyData = await verifyRes.json();

    if (!verifyData.success) {
      console.warn('Turnstile verify failed:', verifyData['error-codes']);
      return res.status(400).json({ error: 'ボット確認に失敗しました。再度お試しください' });
    }
  } catch (err) {
    console.error('Turnstile verify error:', err);
    return res.status(500).json({ error: 'ボット確認エラー' });
  }

  const subjectLabel = SUBJECT_LABELS[subject] || subject || '未選択';

  const html = `
    <div style="font-family: 'Hiragino Sans', sans-serif; line-height:1.7; color:#333; max-width:680px;">
      <h2 style="color:#04384c; border-bottom:2px solid #04384c; padding-bottom:8px;">
        お問い合わせフォームより新着メッセージ
      </h2>
      <table style="width:100%; border-collapse:collapse; margin:20px 0; font-size:14px;">
        <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; width:30%; border:1px solid #ddd;">会社名</th><td style="padding:10px 14px; border:1px solid #ddd;">${esc(company) || '—'}</td></tr>
        <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; border:1px solid #ddd;">お名前</th><td style="padding:10px 14px; border:1px solid #ddd;">${esc(name)}</td></tr>
        <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; border:1px solid #ddd;">メール</th><td style="padding:10px 14px; border:1px solid #ddd;"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
        <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; border:1px solid #ddd;">電話番号</th><td style="padding:10px 14px; border:1px solid #ddd;">${esc(tel) || '—'}</td></tr>
        <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; border:1px solid #ddd;">初回連絡手段</th><td style="padding:10px 14px; border:1px solid #ddd;">${contact_method === 'tel' ? '電話' : 'メール'}</td></tr>
        <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; border:1px solid #ddd;">お問い合わせ種別</th><td style="padding:10px 14px; border:1px solid #ddd;">${esc(subjectLabel)}</td></tr>
      </table>
      <h3 style="color:#04384c; margin-top:24px;">お問い合わせ内容</h3>
      <div style="background:#f7f7f5; padding:18px 22px; border-radius:6px; white-space:pre-wrap; font-size:14.5px; line-height:1.85;">
${esc(message)}
      </div>
      <p style="font-size:12px; color:#888; margin-top:24px;">
        受信日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}<br>
        送信元: kizuna-llc.net contact form
      </p>
    </div>
  `;

  try {
    // 1. 運営宛・通知メール
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      replyTo: email,
      subject: `【KIZUNA問い合わせ】${subjectLabel} / ${name} 様`,
      html,
    });

    if (result.error) {
      console.error('Resend notify error:', result.error);
      return res.status(500).json({ error: 'メール送信に失敗しました' });
    }

    // 2. 問い合わせ者宛・自動返信メール（失敗しても運営宛は届いているので200を返す）
    try {
      const autoReplyHtml = `
        <div style="font-family: 'Hiragino Sans', sans-serif; line-height:1.85; color:#333; max-width:680px;">
          <p>${esc(name)} 様</p>

          <p>このたびはKIZUNA合同会社にお問い合わせいただき、誠にありがとうございます。<br>
          以下の内容でお問い合わせを受け付けました。</p>

          <p><strong>運営担当より、1〜3営業日以内にご返信いたします。</strong><br>
          今しばらくお待ちくださいますようお願いいたします。</p>

          <hr style="border:none; border-top:1px solid #e0e0e0; margin:24px 0;">

          <h3 style="color:#04384c; font-size:16px;">お問い合わせ内容</h3>
          <table style="width:100%; border-collapse:collapse; font-size:14px;">
            <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; width:30%; border:1px solid #ddd;">会社名・屋号</th><td style="padding:10px 14px; border:1px solid #ddd;">${esc(company) || '—'}</td></tr>
            <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; border:1px solid #ddd;">お名前</th><td style="padding:10px 14px; border:1px solid #ddd;">${esc(name)}</td></tr>
            <tr><th align="left" style="background:#f4f8fa; padding:10px 14px; border:1px solid #ddd;">お問い合わせ種別</th><td style="padding:10px 14px; border:1px solid #ddd;">${esc(subjectLabel)}</td></tr>
          </table>

          <h3 style="color:#04384c; font-size:16px; margin-top:24px;">お問い合わせ本文</h3>
          <div style="background:#f7f7f5; padding:18px 22px; border-radius:6px; white-space:pre-wrap; font-size:14.5px;">
${esc(message)}
          </div>

          <hr style="border:none; border-top:1px solid #e0e0e0; margin:32px 0 24px;">

          <p style="font-size:13px; color:#666; line-height:1.85;">
            ※ このメールは自動配信です。本メールに直接ご返信いただいても運営担当には届きません。<br>
            ※ 5営業日経ってもご返信が届かない場合は、お手数ですが再度お問い合わせフォームよりご連絡ください。<br>
            ※ 心当たりのない場合は、本メールを破棄してください。
          </p>

          <hr style="border:none; border-top:1px solid #e0e0e0; margin:24px 0;">

          <p style="font-size:13px; color:#333; line-height:1.85;">
            <strong style="color:#04384c;">KIZUNA合同会社</strong><br>
            東京都中央区銀座7丁目13-6<br>
            🔗 <a href="https://kizuna-llc.net/" style="color:#04384c;">https://kizuna-llc.net/</a>
          </p>
        </div>
      `;

      const autoReplyResult = await resend.emails.send({
        from: FROM_EMAIL,
        to: [email],
        replyTo: TO_EMAIL,
        subject: '【KIZUNA合同会社】お問い合わせを受け付けました',
        html: autoReplyHtml,
      });

      if (autoReplyResult.error) {
        console.warn('Resend auto-reply error:', autoReplyResult.error);
      }
    } catch (autoReplyErr) {
      console.warn('Auto-reply send failed:', autoReplyErr);
      // 自動返信失敗しても、運営宛は成功しているのでユーザーには成功を返す
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact handler error:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
