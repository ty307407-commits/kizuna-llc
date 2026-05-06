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
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      replyTo: email,
      subject: `【KIZUNA問い合わせ】${subjectLabel} / ${name} 様`,
      html,
    });

    if (result.error) {
      console.error('Resend error:', result.error);
      return res.status(500).json({ error: 'メール送信に失敗しました' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact handler error:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
