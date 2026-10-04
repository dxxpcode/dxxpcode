const RESEND_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.RESEND_FROM ?? "DxxpCode <licenses@dxxp.codes>";
const LOGO_URL = "https://dxxp.codes/email-logo.png";

export function mailReady() {
  return Boolean(RESEND_KEY);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function licenseHtml(licenseKey: string): string {
  const key = esc(licenseKey);
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fafafa">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:40px 16px">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e8e8e8;border-radius:12px;padding:36px">
<tr><td style="font-family:'Geist',-apple-system,BlinkMacSystemFont,'Inter','Helvetica Neue','Segoe UI',sans-serif;color:#0a0a0a">
  <img src="${LOGO_URL}" width="34" alt="DxxpCode" style="display:block;width:34px;height:auto;margin:0 0 24px" />
  <h1 style="margin:0 0 8px;font-size:18px;font-weight:600;letter-spacing:-0.01em">Your DxxpCode license</h1>
  <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#666666">Thanks for supporting DxxpCode. Here is your lifetime license key.</p>
  <div style="background:#f5f5f5;border:1px solid #e8e8e8;border-radius:8px;padding:14px 16px;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:14px;letter-spacing:0.02em;word-break:break-all">${key}</div>
  <p style="margin:24px 0 8px;font-size:14px;line-height:1.6;color:#666666">In the app, run:</p>
  <div style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:13px;color:#0a0a0a">/license ${key}</div>
  <hr style="border:none;border-top:1px solid #e8e8e8;margin:28px 0 16px" />
  <p style="margin:0;font-size:12px;line-height:1.6;color:#999999">Keep this email — the key is not shown anywhere else. If you lose it, you can resend it from <a href="https://dxxp.codes/pricing" style="color:#666666">dxxp.codes/pricing</a>.</p>
</td></tr>
</table>
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%"><tr><td align="center" style="padding-top:20px;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Inter','Helvetica Neue',sans-serif;font-size:11px;color:#999999">
  <a href="https://dxxp.codes" style="color:#999999;text-decoration:none">dxxp.codes</a>
</td></tr></table>
</td></tr>
</table>
</body></html>`;
}

// Sends the buyer their license key via the Resend REST API (no SDK dep).
export async function sendLicenseEmail(to: string, licenseKey: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject: "Your DxxpCode license",
      html: licenseHtml(licenseKey),
      text: `Your lifetime license key:\n\n${licenseKey}\n\nIn the app, run:\n\n/license ${licenseKey}\n\nKeep this email — the key is not shown anywhere else.\n`,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}
